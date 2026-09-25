package config

import (
	"encoding/json"
	"testing"
)

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

	// Legacy model seeds the configured provider's entry. The name is
	// kept as saved; lookups match built-ins case-insensitively, and
	// "OpenAI" resolves the same default model as "openai".
	cfg = rawConfig{Provider: "OpenAI", Model: "gpt-4o"}.apply()
	if cfg.Provider != "OpenAI" {
		t.Errorf("provider name rewritten: %q", cfg.Provider)
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

func TestGatherContextToggle(t *testing.T) {
	// Absent from the file means enabled; an explicit false survives a
	// save/load round trip, as does an explicit true.
	cfg := rawConfig{}.apply()
	if !cfg.GatherOn() {
		t.Error("gather should default on")
	}

	off := false
	cfg = rawConfig{GatherContext: &off}.apply()
	if cfg.GatherOn() {
		t.Error("explicit gather_context=false ignored")
	}

	cfg.SetGatherContext(true)
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var raw rawConfig
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if got := raw.apply(); !got.GatherOn() {
		t.Error("explicit true did not round trip")
	}

	cfg.SetGatherContext(false)
	data, err = json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if got := raw.apply(); got.GatherOn() {
		t.Error("explicit false did not round trip")
	}
}

func TestSubagentModelOverride(t *testing.T) {
	// Absent means subagents ride the main model; a stored value is
	// trimmed and survives a save/load round trip.
	cfg := rawConfig{}.apply()
	if cfg.SubModel() != "" {
		t.Error("default subagent model should be empty")
	}
	cfg = rawConfig{SubagentModel: "  fast-model  "}.apply()
	if got := cfg.SubModel(); got != "fast-model" {
		t.Errorf("subagent model = %q, want trimmed fast-model", got)
	}

	cfg.SetSubagentModel("haiku")
	data, err := json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	var raw rawConfig
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if got := raw.apply().SubModel(); got != "haiku" {
		t.Errorf("subagent model did not round trip: %q", got)
	}

	cfg.SetSubagentModel("")
	data, err = json.Marshal(cfg)
	if err != nil {
		t.Fatal(err)
	}
	// A fresh raw: the cleared field is omitted from the JSON (empty +
	// omitempty), and Unmarshal would keep the old value otherwise.
	var cleared rawConfig
	if err := json.Unmarshal(data, &cleared); err != nil {
		t.Fatal(err)
	}
	if got := cleared.apply().SubModel(); got != "" {
		t.Errorf("cleared subagent model came back: %q", got)
	}
}
