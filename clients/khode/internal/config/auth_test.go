package config

import (
	"os"
	"testing"
)

func TestAuthRoundTrip(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	a := LoadAuth()
	if a.Key("anthropic") != "" {
		t.Error("fresh auth should have no keys")
	}

	a.SetKey("anthropic", "sk-ant-test")
	a.SetKey("openai", "sk-openai-test")
	if err := a.Save(); err != nil {
		t.Fatal(err)
	}

	b := LoadAuth()
	if got := b.Key("anthropic"); got != "sk-ant-test" {
		t.Errorf("anthropic key = %q, want sk-ant-test", got)
	}
	if got := b.Key("openai"); got != "sk-openai-test" {
		t.Errorf("openai key = %q, want sk-openai-test", got)
	}

	// An empty SetKey deletes the entry: that is the settings UI's
	// "clear the field and press enter" flow.
	b.SetKey("openai", "")
	if b.Key("openai") != "" {
		t.Error("empty SetKey did not delete the openai key")
	}
	if err := b.Save(); err != nil {
		t.Fatal(err)
	}
	if LoadAuth().Key("openai") != "" {
		t.Error("deleted key came back from disk")
	}
}

func TestAuthFilePermissions(t *testing.T) {
	t.Setenv("HOME", t.TempDir())

	a := LoadAuth()
	a.SetKey("anthropic", "sk-ant-test")
	if err := a.Save(); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(AuthPath())
	if err != nil {
		t.Fatal(err)
	}
	if got := info.Mode().Perm(); got != 0o600 {
		t.Errorf("auth.json mode = %v, want -rw-------", got)
	}
	// The atomic write must not leave temp files behind.
	entries, err := os.ReadDir(Dir())
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if e.Name() == "auth.json.tmp" {
			t.Error("stray auth.json.tmp left behind")
		}
	}
}

func TestBaseURLApply(t *testing.T) {
	cfg := rawConfig{BaseURLs: map[string]string{
		"openai": "http://localhost:8080/v1",
	}}.apply()
	if got := cfg.BaseURL("openai"); got != "http://localhost:8080/v1" {
		t.Errorf("openai base url = %q", got)
	}
	if got := cfg.BaseURL("anthropic"); got != "" {
		t.Errorf("unset base url = %q, want empty", got)
	}
}
