package llm

import (
	"fmt"
	"os"
)

// Provider names understood by New.
const (
	ProviderAnthropic = "anthropic"
	ProviderOpenAI    = "openai"
)

// Names lists the supported providers in a stable order.
func Names() []string { return []string{ProviderAnthropic, ProviderOpenAI} }

// APIKeyEnv returns the environment variable carrying provider's API key
// ("" for unknown providers).
func APIKeyEnv(provider string) string {
	switch provider {
	case ProviderAnthropic:
		return "ANTHROPIC_API_KEY"
	case ProviderOpenAI:
		return "OPENAI_API_KEY"
	}
	return ""
}

// BaseURLEnv returns the environment variable overriding provider's API
// endpoint ("" for unknown providers).
func BaseURLEnv(provider string) string {
	switch provider {
	case ProviderAnthropic:
		return "ANTHROPIC_BASE_URL"
	case ProviderOpenAI:
		return "OPENAI_BASE_URL"
	}
	return ""
}

// Resolve applies the env-over-stored precedence for one provider: an
// environment variable always beats the value saved through the settings
// UI, so shell and CI users keep their existing workflow untouched.
func Resolve(provider, storedKey, storedURL string) (key, baseURL string) {
	if v := os.Getenv(APIKeyEnv(provider)); v != "" {
		key = v
	} else {
		key = storedKey
	}
	if v := os.Getenv(BaseURLEnv(provider)); v != "" {
		baseURL = v
	} else {
		baseURL = storedURL
	}
	return key, baseURL
}

// New builds the provider named name, authenticated with key and pointed
// at baseURL. Either may be empty: the SDK then falls back to its
// environment variables. Missing credentials are deliberately not an
// error — khode starts regardless and collects the key in the settings
// UI; a request without one fails with a clear 401.
func New(name, key, baseURL string) (Provider, error) {
	switch name {
	case ProviderAnthropic:
		return NewAnthropicWithKey(key, baseURL), nil
	case ProviderOpenAI:
		return NewOpenAIWithKey(key, baseURL), nil
	default:
		return nil, fmt.Errorf("unknown provider %q (want anthropic or openai)", name)
	}
}
