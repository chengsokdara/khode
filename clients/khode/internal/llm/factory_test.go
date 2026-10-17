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

func TestNewProtocol(t *testing.T) {
	// A custom provider speaks a built-in protocol under its own name.
	p, err := NewProtocol(ProviderOpenAI, "groq", "test-key", "http://proxy.local/v1")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Name(); got != "groq" {
		t.Errorf("custom provider name = %q, want groq", got)
	}

	p, err = NewProtocol(ProviderAnthropic, "anthropic-proxy", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Name(); got != "anthropic-proxy" {
		t.Errorf("anthropic-protocol custom name = %q", got)
	}

	// An empty display name falls back to the canonical protocol name.
	p, err = NewProtocol(ProviderOpenAI, "", "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Name(); got != "openai" {
		t.Errorf("anonymous provider name = %q, want openai", got)
	}

	if _, err := NewProtocol("grpc", "x", "", ""); err == nil {
		t.Error("unknown protocol accepted")
	}
}
