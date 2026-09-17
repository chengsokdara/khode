package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"
)

// Model listing: the settings UI fetches a provider's model list from
// its endpoint so users pick real models instead of typing names.
// Endpoints that don't implement the list API fail cleanly and the UI
// falls back to manual entry.

// maxModels caps a fetched list; a provider advertising thousands of
// fine-tunes must not flood the config or the picker.
const maxModels = 500

// modelsTimeout bounds one model-list request.
const modelsTimeout = 15 * time.Second

// DefaultEndpoints are the API roots used when no base URL override is
// configured. They mirror what the SDKs use internally.
var DefaultEndpoints = map[string]string{
	ProviderAnthropic: "https://api.anthropic.com",
	ProviderOpenAI:    "https://api.openai.com/v1",
}

// modelList is the response shape both protocols share: a data array of
// objects with an id. (OpenAI: GET /models; Anthropic: GET /v1/models.)
type modelList struct {
	Data []struct {
		ID string `json:"id"`
	} `json:"data"`
}

// FetchModels queries the endpoint for its model list, authenticating
// the way the protocol's requests are authenticated. An empty baseURL
// means the provider's default endpoint. Unknown protocols are an
// error; every failure mode (bad URL, non-200, unparseable body)
// returns an error so the UI can offer manual entry.
func FetchModels(ctx context.Context, protocol, key, baseURL string) ([]string, error) {
	base, known := DefaultEndpoints[protocol]
	if !known {
		return nil, fmt.Errorf("unknown protocol %q", protocol)
	}
	if baseURL != "" {
		base = baseURL
	}

	var url string
	switch protocol {
	case ProviderAnthropic:
		url = strings.TrimRight(base, "/") + "/v1/models?limit=1000"
	case ProviderOpenAI:
		url = strings.TrimRight(base, "/") + "/models?limit=1000"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("building model-list request: %w", err)
	}
	if key != "" {
		if protocol == ProviderAnthropic {
			req.Header.Set("x-api-key", key)
			req.Header.Set("anthropic-version", "2023-06-01")
		} else {
			req.Header.Set("Authorization", "Bearer "+key)
		}
	}

	client := &http.Client{Timeout: modelsTimeout}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetching models: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, fmt.Errorf("fetching models: %s: %s", resp.Status, strings.TrimSpace(string(snippet)))
	}

	var list modelList
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		return nil, fmt.Errorf("parsing model list from %s: %w", url, err)
	}
	seen := make(map[string]bool, len(list.Data))
	models := make([]string, 0, len(list.Data))
	for _, d := range list.Data {
		if d.ID == "" || seen[d.ID] {
			continue
		}
		seen[d.ID] = true
		models = append(models, d.ID)
		if len(models) >= maxModels {
			break
		}
	}
	sort.Strings(models)
	return models, nil
}
