package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/perm"
)

// isolateHOME points config paths at a temp dir for the test's duration.
func isolateHOME(t *testing.T) string {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	if err := os.MkdirAll(Dir(), 0o755); err != nil {
		t.Fatal(err)
	}
	return Dir()
}

func TestLoadMissingFile(t *testing.T) {
	dir := isolateHOME(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Provider != DefaultProvider || cfg.Model() != DefaultModel || cfg.MaxTokens != DefaultMaxTokens {
		t.Errorf("defaults = %+v, want provider/model/max_tokens defaults", cfg)
	}
	if _, err := os.Stat(filepath.Join(dir, "config.json")); !os.IsNotExist(err) {
		t.Error("Load must not create the config file; Save does")
	}
}

func TestLoadLegacySchema(t *testing.T) {
	isolateHOME(t)

	legacy := `{"model": "claude-opus-4-1", "max_tokens": 4096}`
	if err := os.WriteFile(Path(), []byte(legacy), 0o644); err != nil {
		t.Fatal(err)
	}

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.Model() != "claude-opus-4-1" || cfg.MaxTokens != 4096 {
		t.Errorf("legacy config = model %q max %d", cfg.Model(), cfg.MaxTokens)
	}

	// Saving rewrites the file in the current schema: the models map
	// carries the migrated value and the legacy field is gone.
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}
	data, err := os.ReadFile(Path())
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatalf("saved config is not JSON: %v", err)
	}
	if _, ok := raw["model"]; ok {
		t.Error("saved config still has legacy \"model\" field")
	}
	models, _ := raw["models"].(map[string]any)
	if models == nil || models[DefaultProvider] != "claude-opus-4-1" {
		t.Errorf("saved models = %v, want migrated entry", raw["models"])
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	isolateHOME(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	cfg.Provider = "openai"
	cfg.SetModel("gpt-5-mini")
	cfg.PermissionMode = string(perm.ModeAcceptEdits)
	if err := cfg.Save(); err != nil {
		t.Fatalf("Save: %v", err)
	}

	back, err := Load()
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if back.Provider != "openai" || back.Model() != "gpt-5-mini" {
		t.Errorf("round trip = %s/%s, want openai/gpt-5-mini", back.Provider, back.Model())
	}
	if back.PermissionMode != string(perm.ModeAcceptEdits) {
		t.Errorf("permission mode round trip = %q, want %q", back.PermissionMode, perm.ModeAcceptEdits)
	}
}

// An unknown stored mode degrades to the safe default instead of
// erroring the whole load.
func TestLoadUnknownPermissionMode(t *testing.T) {
	isolateHOME(t)

	if err := os.WriteFile(Path(), []byte(`{"permission_mode":"yolo"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	cfg, err := Load()
	if err != nil {
		t.Fatalf("Load: %v", err)
	}
	if cfg.PermissionMode != string(perm.DefaultMode) {
		t.Errorf("unknown mode = %q, want default %q", cfg.PermissionMode, perm.DefaultMode)
	}
}

func TestLoadInvalidJSON(t *testing.T) {
	isolateHOME(t)

	if err := os.WriteFile(Path(), []byte("{not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := Load(); err == nil || !strings.Contains(err.Error(), "parsing config") {
		t.Errorf("invalid config err = %v, want parse error", err)
	}
}
