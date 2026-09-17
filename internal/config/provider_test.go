package config

import "testing"

func TestCredentialsPrecedence(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENAI_BASE_URL", "")

	cfg := rawConfig{BaseURLs: map[string]string{"openai": "http://stored-url"}}.apply()
	a := &Auth{}
	a.SetKey("openai", "stored-key")

	// Empty env vars leave the stored values in charge.
	key, url := cfg.Credentials(a, "openai")
	if key != "stored-key" || url != "http://stored-url" {
		t.Errorf("stored values ignored: key=%q url=%q", key, url)
	}

	// Set env vars win.
	t.Setenv("OPENAI_API_KEY", "env-key")
	t.Setenv("OPENAI_BASE_URL", "http://env-url")
	key, url = cfg.Credentials(a, "openai")
	if key != "env-key" || url != "http://env-url" {
		t.Errorf("env did not win: key=%q url=%q", key, url)
	}
}

func TestCustomProviderCredentials(t *testing.T) {
	cfg := defaults()
	cfg.CustomProviders = map[string]CustomProvider{
		"my-gateway": {Kind: "openai", BaseURL: "http://localhost:8080/v1"},
	}

	if got := cfg.ProviderProtocol("my-gateway"); got != "openai" {
		t.Errorf("protocol = %q, want openai", got)
	}
	// The env name derives from the provider name: MY_GATEWAY_API_KEY.
	if got := cfg.APIKeyEnvName("my-gateway"); got != "MY_GATEWAY_API_KEY" {
		t.Errorf("key env name = %q", got)
	}
	if got := cfg.BaseURLEnvName("my-gateway"); got != "MY_GATEWAY_BASE_URL" {
		t.Errorf("url env name = %q", got)
	}

	a := &Auth{}
	a.SetKey("my-gateway", "stored-key")
	t.Setenv("MY_GATEWAY_API_KEY", "")
	key, url := cfg.Credentials(a, "my-gateway")
	if key != "stored-key" || url != "http://localhost:8080/v1" {
		t.Errorf("stored credentials ignored: key=%q url=%q", key, url)
	}

	t.Setenv("MY_GATEWAY_API_KEY", "env-key")
	key, _ = cfg.Credentials(a, "my-gateway")
	if key != "env-key" {
		t.Errorf("env key ignored: %q", key)
	}
}

func TestCustomProviderModelIsEmptyUntilSet(t *testing.T) {
	cfg := defaults()
	cfg.CustomProviders = map[string]CustomProvider{
		"my-gateway": {Kind: "openai", BaseURL: "http://localhost:8080/v1"},
	}
	cfg.Provider = "my-gateway"

	// A custom provider must never inherit a built-in's default model:
	// the endpoint would get a request for claude-sonnet.
	if got := cfg.Model(); got != "" {
		t.Errorf("custom model = %q, want empty", got)
	}

	// The first cached choice becomes the fallback.
	cfg.SetModelChoices("my-gateway", []string{"llama3", "qwen"})
	if got := cfg.Model(); got != "llama3" {
		t.Errorf("model = %q, want llama3 (first choice)", got)
	}

	// An explicit choice wins; one not already in the list is cached.
	cfg.SetModel("qwen")
	if got := cfg.Model(); got != "qwen" {
		t.Errorf("model = %q, want qwen", got)
	}
	cfg.SetModel("llama3:70b")
	if got := cfg.ModelChoices["my-gateway"]; len(got) != 3 || got[2] != "llama3:70b" {
		t.Errorf("choices after SetModel = %v (manual entry should be cached)", got)
	}
}

func TestModelChoicesAddRemove(t *testing.T) {
	cfg := defaults()

	if cfg.AddModelChoice("anthropic", "") {
		t.Error("empty model accepted")
	}
	if !cfg.AddModelChoice("anthropic", "claude-x") {
		t.Error("new model not added")
	}
	if cfg.AddModelChoice("anthropic", "claude-x") {
		t.Error("duplicate model added twice")
	}

	cfg.RemoveModelChoice("anthropic", "claude-x")
	if len(cfg.ModelChoices["anthropic"]) != 0 {
		t.Errorf("choices after removal = %v", cfg.ModelChoices["anthropic"])
	}
	if _, ok := cfg.ModelChoices["anthropic"]; ok {
		t.Error("empty choice list not dropped from the map")
	}

	// Switching away and back does not resurrect another provider's
	// choices; the built-in default still applies.
	cfg.SetModelChoices("openai", []string{"gpt-x"})
	cfg.Provider = "openai"
	if got := cfg.Model(); got != "gpt-x" {
		t.Errorf("openai model = %q, want gpt-x (first choice)", got)
	}
	cfg.SetModelChoices("openai", nil)
	if got := cfg.Model(); got != "gpt-5-mini" {
		t.Errorf("openai model after clearing choices = %q, want built-in default", got)
	}
}
