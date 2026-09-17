package llm

import (
	"fmt"
)

// Provider names understood by New.
const (
	ProviderAnthropic = "anthropic"
	ProviderOpenAI    = "openai"
)

// Names lists the built-in providers in a stable order. Custom
// providers are config-level names that reuse these protocols.
func Names() []string { return []string{ProviderAnthropic, ProviderOpenAI} }

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
	switch protocol {
	case ProviderAnthropic:
		return newAnthropicClient(key, baseURL, name), nil
	case ProviderOpenAI:
		return newOpenAIClient(key, baseURL, name), nil
	default:
		return nil, fmt.Errorf("unknown provider protocol %q (want %s or %s)",
			protocol, ProviderAnthropic, ProviderOpenAI)
	}
}
