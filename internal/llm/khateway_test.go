package llm

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestKhatewayProtocol(t *testing.T) {
	cases := []struct {
		name         string
		baseURL      string
		wantProtocol string
		wantBase     string
	}{
		{"empty rides the default endpoint", "", ProviderOpenAI, DefaultKhatewayEndpoint},
		{"openai-shaped base unchanged", "http://localhost:8787/v1", ProviderOpenAI, "http://localhost:8787/v1"},
		{"bare origin unchanged", "http://gw.lan:8787", ProviderOpenAI, "http://gw.lan:8787"},
		{"anthropic face resolved", "http://gw.lan:8787/v1/messages", ProviderAnthropic, "http://gw.lan:8787"},
		{"trailing slash trimmed", "http://gw.lan:8787/", ProviderOpenAI, "http://gw.lan:8787"},
	}
	for _, tc := range cases {
		protocol, base := KhatewayProtocol(tc.baseURL)
		if protocol != tc.wantProtocol || base != tc.wantBase {
			t.Errorf("%s: KhatewayProtocol(%q) = (%q, %q), want (%q, %q)",
				tc.name, tc.baseURL, protocol, base, tc.wantProtocol, tc.wantBase)
		}
	}
}

func TestNewKhateway(t *testing.T) {
	p, err := New(ProviderKhateway, "khat-key", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name() != ProviderKhateway {
		t.Errorf("Name() = %q, want khateway", p.Name())
	}

	// A /v1/messages base makes khateway speak the anthropic protocol
	// under its own display name.
	t.Setenv("KHATEWAY_API_KEY", "")
	p, err = NewProtocol(ProviderKhateway, "khateway", "k", "http://gw.lan:8787/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	if got := p.Name(); got != "khateway" {
		t.Errorf("anthropic-face Name() = %q, want khateway", got)
	}
}

func TestNewKhatewayEnvKey(t *testing.T) {
	// The env fallback only applies when no explicit key is given, so
	// config.Credentials precedence (env beats stored) is preserved
	// one layer up.
	t.Setenv("KHATEWAY_API_KEY", "env-key")
	if got := orEnv("", "KHATEWAY_API_KEY"); got != "env-key" {
		t.Errorf("orEnv empty key = %q, want env-key", got)
	}
	if got := orEnv("stored-key", "KHATEWAY_API_KEY"); got != "stored-key" {
		t.Errorf("orEnv explicit key = %q, want stored-key", got)
	}
}

func TestFetchModelsKhateway(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"glm-5.3-flash"},{"id":"claude-x"}]}`)
	}))
	defer srv.Close()

	models, err := FetchModels(context.Background(), ProviderKhateway, "khat-key", srv.URL+"/v1/messages")
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/models" {
		t.Errorf("path = %q, want /models (openai face)", gotPath)
	}
	if gotAuth != "Bearer khat-key" {
		t.Errorf("Authorization = %q, want Bearer khat-key", gotAuth)
	}
	if strings.Join(models, ",") != "claude-x,glm-5.3-flash" {
		t.Errorf("models = %v", models)
	}
}

// With no key configured, khateway still constructs (the placeholder
// exists purely so the SDK clients build) and picks up no stray
// built-in env key: KHATEWAY_API_KEY is the only env khateway ever
// reads. The UI's pre-flight check keeps such a provider from firing
// requests, so the placeholder is never on the wire.
func TestNewKhatewayWithoutKey(t *testing.T) {
	t.Setenv("KHATEWAY_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "stray-key")
	t.Setenv("ANTHROPIC_API_KEY", "")

	p, err := New(ProviderKhateway, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if p.Name() != ProviderKhateway {
		t.Errorf("Name() = %q, want khateway", p.Name())
	}
}
