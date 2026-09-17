package llm

import (
	"fmt"
	"os"
)

// Provider names understood by New.
const (
	ProviderAnthropic = "anthropic"
	ProviderOpenAI    = "openai"
	ProviderKhateway  = "khateway"
)

// Names lists the built-in providers in a stable order. Custom
// providers are config-level names that reuse these protocols.
func Names() []string { return []string{ProviderAnthropic, ProviderOpenAI, ProviderKhateway} }

// New builds one of the built-in providers, authenticated with key and
// pointed at baseURL. Either may be empty: the SDK then falls back to
// its environment variables. Missing credentials are deliberately not
// an error — khode starts regardless and collects the key in the
// settings UI; a request without one fails with a clear 401.
func New(name, key, baseURL string) (Provider, error) {
	return NewProtocol(name, name, key, baseURL)
}

// NewProtocol builds a provider that speaks protocol ("anthropic" or
// "openai") under display name name — the same client either way, which
// is what makes custom providers possible: any OpenAI-compatible or
// Anthropic-protocol endpoint becomes a provider. Empty key/baseURL
// fall back to the SDK's environment lookup; empty name reports the
// protocol's canonical name.
func NewProtocol(protocol, name, key, baseURL string) (Provider, error) {
	// khateway runs both wire protocols on one origin: the endpoint's
	// shape picks the face (…/v1/messages → anthropic, else openai).
	// SDK env fallbacks are disabled so a stray ANTHROPIC_API_KEY can
	// never authenticate a khateway request, and a missing key becomes
	// a placeholder: khateway is keyless-native (the gateway fronts
	// upstream auth), while the anthropic SDK would otherwise refuse to
	// build the request client-side and the openai SDK would leak
	// OPENAI_API_KEY as a bearer token.
	if protocol == ProviderKhateway {
		protocol, baseURL = KhatewayProtocol(baseURL)
		key = orEnv(key, "KHATEWAY_API_KEY")
		if key == "" {
			key = khatewayAnonKey
		}
	}
	switch protocol {
	case ProviderAnthropic:
		return newAnthropicClient(key, baseURL, name), nil
	case ProviderOpenAI:
		return newOpenAIClient(key, baseURL, name), nil
	default:
		return nil, fmt.Errorf("unknown provider protocol %q (want %s, %s or %s)",
			protocol, ProviderAnthropic, ProviderOpenAI, ProviderKhateway)
	}
}

// orEnv returns env's value when key is empty, so KHATEWAY_API_KEY
// works like the built-ins' SDK env lookup without a config change.
func orEnv(key, env string) string {
	if key != "" {
		return key
	}
	return os.Getenv(env)
}
