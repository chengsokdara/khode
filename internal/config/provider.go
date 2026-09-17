package config

import (
	"os"
	"strings"
)

// Provider-level resolution: which wire protocol a provider speaks,
// where its credentials come from, and which models it offers. Env vars
// win over stored values, so shell and CI workflows stay untouched.

// ProviderProtocol returns the wire protocol provider speaks: built-ins
// are their own protocol; custom providers carry theirs in Kind.
// Unknown names come back unchanged, so a bad config value surfaces as
// an llm.NewProtocol error instead of silently routing somewhere else.
func (c *Config) ProviderProtocol(provider string) string {
	if cp, ok := c.CustomProviders[provider]; ok && cp.Kind != "" {
		return cp.Kind
	}
	return provider
}

// APIKeyEnvName returns the environment variable that overrides
// provider's API key: canonical names for built-ins, an uppercased
// NAME_API_KEY for everything else (custom provider "groq" reads
// GROQ_API_KEY).
func (c *Config) APIKeyEnvName(provider string) string {
	if IsBuiltinProvider(provider) {
		switch provider {
		case "anthropic":
			return "ANTHROPIC_API_KEY"
		case "openai":
			return "OPENAI_API_KEY"
		}
	}
	return envPrefix(provider) + "_API_KEY"
}

// BaseURLEnvName returns the environment variable that overrides
// provider's endpoint, following the same naming rule as APIKeyEnvName.
func (c *Config) BaseURLEnvName(provider string) string {
	if IsBuiltinProvider(provider) {
		switch provider {
		case "anthropic":
			return "ANTHROPIC_BASE_URL"
		case "openai":
			return "OPENAI_BASE_URL"
		}
	}
	return envPrefix(provider) + "_BASE_URL"
}

// envPrefix maps a provider name to its environment-variable fragment:
// uppercased, with every non-alphanumeric rune flattened to '_'.
func envPrefix(provider string) string {
	var b strings.Builder
	for _, r := range strings.ToUpper(provider) {
		switch {
		case r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	return b.String()
}

// Credentials resolves provider's API key and base URL: an environment
// variable wins over the stored value (auth.json / config.json for
// built-ins, the custom provider's own entry for customs).
func (c *Config) Credentials(a *Auth, provider string) (key, baseURL string) {
	if v := os.Getenv(c.APIKeyEnvName(provider)); v != "" {
		key = v
	} else {
		key = a.Key(provider)
	}
	if v := os.Getenv(c.BaseURLEnvName(provider)); v != "" {
		baseURL = v
	} else if cp, ok := c.CustomProviders[provider]; ok && cp.BaseURL != "" {
		baseURL = cp.BaseURL
	} else {
		baseURL = c.BaseURL(provider)
	}
	return key, baseURL
}

// SetModelChoices replaces provider's cached model list (the result of
// a fetch, or a manually curated list). An empty list removes the entry.
func (c *Config) SetModelChoices(provider string, models []string) {
	if c.ModelChoices == nil {
		c.ModelChoices = map[string][]string{}
	}
	if len(models) == 0 {
		delete(c.ModelChoices, provider)
		return
	}
	c.ModelChoices[provider] = models
}

// maxModelChoices caps a provider's cached model list so a chatty
// endpoint cannot balloon the config file.
const maxModelChoices = 500

// AddModelChoice appends model to provider's cached list unless it is
// already there. Reports whether the list changed.
func (c *Config) AddModelChoice(provider, model string) bool {
	if model == "" {
		return false
	}
	for _, m := range c.ModelChoices[provider] {
		if m == model {
			return false
		}
	}
	if len(c.ModelChoices[provider]) >= maxModelChoices {
		return false
	}
	if c.ModelChoices == nil {
		c.ModelChoices = map[string][]string{}
	}
	c.ModelChoices[provider] = append(c.ModelChoices[provider], model)
	return true
}

// RemoveModelChoice drops model from provider's cached list; a missing
// model is not an error. The active model is left alone — callers
// decide whether removing it should unset it.
func (c *Config) RemoveModelChoice(provider, model string) {
	choices := c.ModelChoices[provider]
	for i, m := range choices {
		if m == model {
			choices = append(choices[:i], choices[i+1:]...)
			break
		}
	}
	if len(choices) == 0 {
		delete(c.ModelChoices, provider)
		return
	}
	c.ModelChoices[provider] = choices
}
