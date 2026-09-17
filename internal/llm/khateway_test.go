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

// Keyless khateway must still produce a well-formed request on both
// faces: the anonymous placeholder goes out (never a stray OPENAI_API_KEY
// bearer, and the anthropic SDK must not refuse client-side).
func TestKhatewayKeylessRequests(t *testing.T) {
	var gotAuth, gotAPIKey string
	openaiFace := func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"))
		w.Write([]byte("data: [DONE]\n\n"))
	}
	anthropicFace := func(w http.ResponseWriter, r *http.Request) {
		gotAPIKey = r.Header.Get("x-api-key")
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"m\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n"))
		w.Write([]byte("event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":1}}\n\n"))
		w.Write([]byte("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"))
	}

	t.Run("openai face", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(openaiFace))
		defer srv.Close()
		t.Setenv("KHATEWAY_API_KEY", "")
		t.Setenv("OPENAI_API_KEY", "stray-key") // must never reach khateway

		p, err := New(ProviderKhateway, "", srv.URL)
		if err != nil {
			t.Fatal(err)
		}
		ch, err := p.Stream(t.Context(), Request{Model: "m", Messages: []Message{{Role: RoleUser, Content: "hi"}}})
		if err != nil {
			t.Fatal(err)
		}
		for ev := range ch {
			if e, ok := ev.(ErrorEvent); ok {
				t.Fatalf("stream failed: %v", e.Err)
			}
		}
		if gotAuth != "Bearer "+khatewayAnonKey {
			t.Errorf("Authorization = %q, want the anonymous placeholder (stray env key must not leak)", gotAuth)
		}
	})

	t.Run("anthropic face", func(t *testing.T) {
		srv := httptest.NewServer(http.HandlerFunc(anthropicFace))
		defer srv.Close()
		t.Setenv("KHATEWAY_API_KEY", "")
		t.Setenv("ANTHROPIC_API_KEY", "") // unset: SDK would refuse client-side

		p, err := New(ProviderKhateway, "", srv.URL+"/v1/messages")
		if err != nil {
			t.Fatal(err)
		}
		ch, err := p.Stream(t.Context(), Request{Model: "m", Messages: []Message{{Role: RoleUser, Content: "hi"}}})
		if err != nil {
			t.Fatal(err)
		}
		for ev := range ch {
			if e, ok := ev.(ErrorEvent); ok {
				t.Fatalf("stream failed: %v", e.Err)
			}
		}
		if gotAPIKey != khatewayAnonKey {
			t.Errorf("x-api-key = %q, want the anonymous placeholder", gotAPIKey)
		}
	})
}
