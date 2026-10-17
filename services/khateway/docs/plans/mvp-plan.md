# Khateway — MVP Build Plan

**Status:** Approved (2026-09-16) · **Location:** `~/Apps/khateway/` · **Audience:** internal (the user's team)

> Khateway is a self-hosted AI model router, OpenRouter-style: clients hit **one base URL**
> and speak any of the big-3 API dialects; Khateway translates and routes to whichever
> upstream provider serves the model.

---

## 1. Locked decisions (do not re-litigate)

| Decision | Choice |
|---|---|
| Audience | Internal — single admin dashboard, client API keys for the gateway. No signup/billing. |
| Stack | Cloudflare Workers: **Hono** (API) + **D1/SQLite** (storage) + **React SPA** (admin, served as static assets by the same Worker) |
| Gemini | Via Google's official **OpenAI-compatible** endpoint; native adapter deferred |
| Tool calling | **Included in v1** — full dialect translation (openai ↔ anthropic ↔ responses) |
| Language naming | Project name **Khateway**, folder `khateway/` (sibling of termagent code) |
| UI style | Dark-first "developer tool" aesthetic, professional; React + Tailwind, hand-rolled component kit, TanStack Query |

## 2. Product promise

| Client calls ↓ / upstream adapter → | `openai-compatible` | `anthropic` |
|---|---|---|
| `POST /v1/chat/completions` | ✅ | ✅ |
| `POST /v1/responses` | ✅ | ✅ |
| `POST /v1/messages` | ✅ | ✅ |

Translation is **any-to-any** for requests *and* SSE streaming. The
`openai` adapter also covers Groq, DeepSeek, xAI, Mistral, OpenRouter, Together,
Ollama, vLLM and Gemini-compat — all via provider `base_url` override.

## 3. Architecture

- **One deployable**: Hono Worker serves the admin SPA as static assets and handles `/v1/*` + `/admin/*`.
- **Pipeline**: client dialect adapter → canonical request → route (slug → model → provider, pinned/fallback) → upstream adapter → provider `base_url` with upstream credentials → response/SSE translated back into the caller's dialect.
- Local dev = `wrangler dev` with a local SQLite D1 file — no Cloudflare account needed until deploy.

### Dialect translation gotchas (the real value, must-handles in v1)

- Streaming: OpenAI `data:` chunks + `[DONE]`, Anthropic events (`message_start`/`content_block_delta`/`message_stop`), Responses events (`response.output_text.delta`/`response.completed`) — three SSE wire formats.
- Stop reasons: `finish_reason: stop/length/tool_calls` ↔ `stop_reason: end_turn/max_tokens/tool_use`.
- Tool calls: `function.arguments` (string JSON) ↔ `tool_use.input` (object) ↔ Responses `function_call` output items; tool schema `parameters` vs `input_schema`.
- Auth/header forms: OpenAI `Bearer` vs Anthropic `x-api-key` + `anthropic-version`.
- `max_tokens` vs `max_completion_tokens` (reasoning models); `system` message positioning.
- Usage: `prompt_tokens/completion_tokens` ↔ `input_tokens/output_tokens`.

## 4. Data model

| Table | Key fields |
|---|---|
| `providers` | id, name, adapter (`openai`\|`anthropic`), base_url (null ⇒ adapter default), api_key_enc (AES-GCM), key_hint, default_headers(JSON), timeout_ms, enabled, ts fields |
| `models` | id, provider_id (cascade), slug (globally unique), upstream_model, display_name, context_window, max_output_tokens, pricing_input/output (USD per 1M), capabilities(JSON), fallbacks(JSON), base_url_override, api_key_override_enc, enabled, ts fields |
| `api_keys` | id, name, key_hash (SHA-256), key_prefix, spend_limit_usd, allowed_models(JSON), enabled, last_used_at, ts fields |
| `request_logs` | id, api_key_id, model_slug, provider_id, upstream_model, dialect, status, latency_ms, tokens_in/out, cost_usd, error, created_at |

Rules: provider API keys encrypted at rest (AES-256-GCM, key from env). Client keys stored as SHA-256 hashes only, prefix kept for UI. Logs snapshot per-request usage + pricing.

## 5. Endpoints

**Gateway (built M3–M6):** `POST /v1/chat/completions`, `POST /v1/responses`, `POST /v1/messages`, `GET /v1/models`, `GET /v1/models/:id`. Auth: `Authorization: Bearer` client key. `model` = platform slug (e.g. `gpt-5`, `claude-sonnet-4-5`) or provider-pinned `anthropic/claude-sonnet-4-5`. Fallback chains per model (ordered retries on 429/5xx/timeout).

**Admin (M1–M2):** `POST /admin/login` (password → HttpOnly session cookie) ·
`GET /admin/overview` · CRUD `/admin/providers` + `POST /admin/providers/:id/test` ·
CRUD `/admin/models` (+ later `/admin/api-keys`, `/admin/logs`, usage summary).

## 6. Milestones

| # | Ships | Done when |
|---|---|---|
| M1 | Scaffold: Hono + Vite SPA + D1/Drizzle + migrations, admin login (env password, cookie session), app shell (dark theme, nav) | Team can log in |
| M2 | Providers & Models CRUD, AES-GCM key encryption, Test-connection, enable toggles | Full config UI on live D1 |
| M3 | Gateway core: canonical pipeline, openai adapter, routing + provider pinning, `/v1/chat/completions` + `/v1/models`, error mapping | OpenAI SDK curl works |
| M4 | Anthropic adapter + `/v1/messages`; cross-dialect SSE translation (any dialect in → any upstream) | Anthropic SDK drop-in works |
| M5 | `/v1/responses` + Responses event translation | All 3 dialects live |
| M6 | Tool-calling + vision + usage/stop-reason mapping across dialects; fallback chains & retries | Agent traffic passes |
| M7 | Client API keys + spend caps, request logs + cost calc + logs UI, curl/SDK snippets, polish | MVP complete |

Each milestone is demoable when merged; no long integration death-march.

## 7. Security & ops notes

- Secrets via env/.dev.vars: `ADMIN_PASSWORD`, `ENCRYPTION_KEY` (32-byte base64), optional `SESSION_SECRET`. Never commit real values.
- Logs redact `Authorization`/`x-api-key` headers, truncate bodies, optional Cron purge later.
- Workers free tier is fine: fallback subrequests under limits, SSE relay is CPU-free.
- SPA served from `web-dist/` static assets; `/v1/*`, `/admin/*`, `/health` are worker-first.

## 8. Testing strategy

- **Golden-fixture adapter tests** (real captured request/response pairs; Vitest) assert translations round-trip — highest-value tests in this kind of project.
- Curl smoke script for dialect × upstream matrix as milestones land.

## 9. Deliberately OUT of MVP (phase 2+)

Billing/Stripe, orgs/teams, rate-limit middleware, semantic caching, multi-key load balancing, embeddings/images/audio endpoints, batch API, playground UI, docs portal, Bedrock/Azure/native-Gemini adapters, SSO/audit.

## 10. Implementation status log

- 2026-09-17 — DECISION AMENDMENT (user): audience changed from internal to **PUBLIC**; Stripe replaced by **merchant-of-record billing** (Lemon Squeezy first pick — Cambodia in its bank-payout list; Paddle/Polar fallbacks; KHQR/Bakong for local customers). Post-MVP roadmap M8–M14 lives in `../STATUS.md`. §1's internal-audience row is superseded by this amendment.
- 2026-09-16 — Plan approved; M1 + M2 implemented in `khateway/` (scaffold, auth, providers/models CRUD, test-connection, SPA dashboard). See `../STATUS.md`-style entries in the repo-root `STATUS.md`.
- 2026-09-16 — M3–M6 shipped (gateway core, anthropic dialect + cross-dialect translation, `/v1/responses`, tools/vision + fallback chains). See repo-root `STATUS.md`.
- 2026-09-16 — **M7 shipped — MVP complete**: client API keys (sha-256, `khat-…`, shown once), gateway auth (`Bearer` + `x-api-key`), spend caps (429 insufficient_quota), allowed-model lists (403 permission_error), request logs with latency/token/cost capture (SSE usage via tee watcher), admin API-keys + Logs pages, SDK snippets. Gateway smoke 112/112; live-verified against z.ai coding plan `glm-5.3-flash` via `/v1/responses` (non-stream + stream). Note: z.ai coding-plan keys require the `/api/coding/paas/v4` base.
