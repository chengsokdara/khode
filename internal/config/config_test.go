package config

import "testing"

func TestModelPrecedence(t *testing.T) {
	// Every known provider must have a built-in default model.
	for _, p := range []string{"anthropic", "openai"} {
		cfg := defaults()
		cfg.Provider = p
		if got := cfg.Model(); got == "" {
			t.Errorf("provider %q has no default model", p)
		}
	}

	cfg := defaults()
	if got, want := cfg.Model(), DefaultModel; got != want {
		t.Errorf("fresh config model = %q, want %q", got, want)
	}

	// A provider switch falls back to that provider's default, not the
	// previous provider's model.
	cfg.Provider = "openai"
	if got, want := cfg.Model(), "gpt-5-mini"; got != want {
		t.Errorf("openai fallback model = %q, want %q", got, want)
	}

	// The provider's last-used model wins over its built-in default.
	cfg.SetModel("gpt-4o")
	if got, want := cfg.Model(), "gpt-4o"; got != want {
		t.Errorf("model after SetModel = %q, want %q", got, want)
	}

	// The session override wins over everything; SetModel clears it.
	cfg.SetModelOverride("o4-mini")
	if got, want := cfg.Model(), "o4-mini"; got != want {
		t.Errorf("model with override = %q, want %q", got, want)
	}
	cfg.SetModel("gpt-4o")
	if got, want := cfg.Model(), "gpt-4o"; got != want {
		t.Errorf("override not cleared by SetModel: model = %q, want %q", got, want)
	}

	// Per-provider entries do not leak across providers.
	cfg.Provider = "anthropic"
	if got, want := cfg.Model(), DefaultModel; got != want {
		t.Errorf("anthropic model after openai SetModel = %q, want %q", got, want)
	}
}

func TestLegacyMigration(t *testing.T) {
	// Old schema: only "model", no provider/models.
	cfg := rawConfig{Model: "claude-opus-4-1"}.apply()
	if cfg.Provider != DefaultProvider {
		t.Errorf("provider = %q, want default %q", cfg.Provider, DefaultProvider)
	}
	if got := cfg.Model(); got != "claude-opus-4-1" {
		t.Errorf("legacy model not migrated: got %q", got)
	}

	// Legacy model seeds the configured provider's entry.
	cfg = rawConfig{Provider: "OpenAI", Model: "gpt-4o"}.apply()
	if cfg.Provider != "openai" {
		t.Errorf("provider not lowercased: %q", cfg.Provider)
	}
	if got := cfg.Model(); got != "gpt-4o" {
		t.Errorf("legacy model for openai = %q, want gpt-4o", got)
	}

	// An explicit models entry wins over the legacy field.
	cfg = rawConfig{
		Provider: "openai",
		Model:    "gpt-4o",
		Models:   map[string]string{"openai": "gpt-5-mini"},
	}.apply()
	if got := cfg.Model(); got != "gpt-5-mini" {
		t.Errorf("models entry ignored: got %q, want gpt-5-mini", got)
	}
}
