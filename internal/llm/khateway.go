package llm

import "strings"

// Khateway is a built-in provider that targets a self-hosted Khateway
// router (github.com/... — the OpenRouter-style gateway). One base URL
// and one client key (khat-…) front every upstream the gateway admin
// configured, so khode gains whatever models the router exposes without
// per-vendor keys. Khateway speaks both wire protocols on the same
// origin, so khode always talks one of the two SDK clients — only the
// endpoint spelling decides which, see KhatewayProtocol.

// DefaultKhatewayEndpoint is the local dev gateway used when no base
// URL is configured. OpenAI-style shape: /v1 + /chat/completions etc.
const DefaultKhatewayEndpoint = "http://localhost:8787/v1"

// KhatewayProtocol resolves a khateway base URL into the wire protocol
// and base URL its client expects. An anthropic-SDK-shaped base (…
// /v1/messages) gets the anthropic client with the suffix stripped —
// that is the only spelling that distinguishes the two faces, since
// khateway serves both from one origin. Everything else (including the
// default endpoint) rides the openai client, which also covers the
// shared GET /v1/models listing and khateway's /v1/responses dialect.
func KhatewayProtocol(baseURL string) (protocol, base string) {
	if baseURL == "" {
		baseURL = DefaultKhatewayEndpoint
	}
	b := strings.TrimRight(baseURL, "/")
	if strings.HasSuffix(b, "/v1/messages") {
		return ProviderAnthropic, strings.TrimSuffix(b, "/v1/messages")
	}
	return ProviderOpenAI, b
}
