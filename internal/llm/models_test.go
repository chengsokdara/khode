package llm

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestFetchModelsOpenAI(t *testing.T) {
	var gotPath, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"b-model"},{"id":"a-model"},{"id":"b-model"},{"id":""}]}`)
	}))
	defer srv.Close()

	models, err := FetchModels(context.Background(), ProviderOpenAI, "k1", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/models" {
		t.Errorf("path = %q, want /models", gotPath)
	}
	if gotAuth != "Bearer k1" {
		t.Errorf("Authorization = %q, want Bearer k1", gotAuth)
	}
	// Sorted, deduplicated, empty ids dropped.
	if strings.Join(models, ",") != "a-model,b-model" {
		t.Errorf("models = %v", models)
	}
}

func TestFetchModelsAnthropic(t *testing.T) {
	var gotPath, gotKey, gotVersion string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotKey = r.Header.Get("x-api-key")
		gotVersion = r.Header.Get("anthropic-version")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"claude-sonnet-4-5"}],"has_more":false}`)
	}))
	defer srv.Close()

	models, err := FetchModels(context.Background(), ProviderAnthropic, "k2", srv.URL)
	if err != nil {
		t.Fatal(err)
	}
	if gotPath != "/v1/models" {
		t.Errorf("path = %q, want /v1/models", gotPath)
	}
	if gotKey != "k2" || gotVersion == "" {
		t.Errorf("anthropic headers missing: x-api-key=%q version=%q", gotKey, gotVersion)
	}
	if strings.Join(models, ",") != "claude-sonnet-4-5" {
		t.Errorf("models = %v", models)
	}
}

func TestFetchModelsFailures(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"bad key"}`)
	}))
	defer srv.Close()

	if _, err := FetchModels(context.Background(), ProviderOpenAI, "bad", srv.URL); err == nil {
		t.Error("401 accepted")
	} else if !strings.Contains(err.Error(), "401") {
		t.Errorf("error %q does not mention the status", err)
	}

	if _, err := FetchModels(context.Background(), "grpc", "", srv.URL); err == nil {
		t.Error("unknown protocol accepted")
	}
}
