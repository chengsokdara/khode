package llm

import "testing"

func TestNewFactory(t *testing.T) {
	for _, name := range Names() {
		p, err := New(name, "test-key", "")
		if err != nil {
			t.Fatalf("New(%q): %v", name, err)
		}
		if p.Name() != name {
			t.Errorf("New(%q).Name() = %q", name, p.Name())
		}
	}
	if _, err := New("nope", "", ""); err == nil {
		t.Error("unknown provider accepted")
	}
}

func TestResolveEnvWins(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "env-key")
	t.Setenv("ANTHROPIC_BASE_URL", "http://env-url")
	key, url := Resolve("anthropic", "stored-key", "http://stored-url")
	if key != "env-key" || url != "http://env-url" {
		t.Errorf("env did not win: key=%q url=%q", key, url)
	}

	// Empty (or unset) env vars leave the stored values in charge —
	// that is how the settings UI's key gets used.
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("OPENAI_BASE_URL", "")
	key, url = Resolve("openai", "stored-key", "http://stored-url")
	if key != "stored-key" || url != "http://stored-url" {
		t.Errorf("stored values ignored: key=%q url=%q", key, url)
	}
}

func TestEnvNameHelpers(t *testing.T) {
	if got := APIKeyEnv("anthropic"); got != "ANTHROPIC_API_KEY" {
		t.Errorf("APIKeyEnv(anthropic) = %q", got)
	}
	if got := APIKeyEnv("openai"); got != "OPENAI_API_KEY" {
		t.Errorf("APIKeyEnv(openai) = %q", got)
	}
	if got := BaseURLEnv("openai"); got != "OPENAI_BASE_URL" {
		t.Errorf("BaseURLEnv(openai) = %q", got)
	}
	if got := APIKeyEnv("nope"); got != "" {
		t.Errorf("APIKeyEnv(unknown) = %q, want empty", got)
	}
}
