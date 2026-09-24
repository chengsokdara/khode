package llm

import "strings"

// Khateway is a built-in provider that targets a self-hosted Khateway
// router (github.com/... — the OpenRouter-style gateway). One base URL
// and one client key (khat-…) front every upstream the gateway admin
// configured, so khode gains whatever models the router exposes without
// per-vendor keys. Khateway speaks both wire protocols on the same
// origin, so khode always talks one of the two SDK clients — only the
// endpoint spelling decides which, see KhatewayProtocol.

// DefaultKhatewayEndpoint is the deployed gateway khode ships pointed
// at: khateway is first-class native, so a fresh install works with no
// configuration — pick the provider, /login, go. OpenAI-style shape:
// /v1 + /chat/completions etc. Point KHATEWAY_BASE_URL at a local dev
// gateway to override.
const DefaultKhatewayEndpoint = "https://khateway.chengsokdara.workers.dev/v1"

// khatewayUnauthenticatedPlaceholder is a construction-time stand-in,
// never a credential. Both SDKs need a non-empty credential to build
// their client: the anthropic client refuses to send any request
// without one (NoCredentialsError), and the openai client silently
// falls back to OPENAI_API_KEY — leaking an unrelated key to the
// gateway. The UI's pre-flight credential check stops a keyless
// khateway turn before any request fires, so this value is unreachable
// on the wire (the gateway would answer 401 invalid_api_key if it ever
// leaked); it exists purely so the client objects build. A real key —
// stored or KHATEWAY_API_KEY — always wins over it.
const khatewayUnauthenticatedPlaceholder = "khode-unauthenticated"

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
