# Khateway — AI model router

One base URL for every model. Khateway is a self-hosted, OpenRouter-style gateway:
clients speak any of the big-3 API dialects against **your** endpoint, and Khateway
translates and routes each request to the provider that serves the model.

```
openai / anthropic / groq / deepseek / xai / openrouter / ollama /
gemini (native generateContent or OpenAI-compat) …
                 │ register providers + models (admin dashboard)
                 ▼
  POST /v1/chat/completions      ← OpenAI Chat dialect
  POST /v1/completions           ← Legacy OpenAI text completions
  POST /v1/responses             ← OpenAI Responses API
  POST /v1/messages              ← Anthropic Messages
  POST /v1/embeddings            ← OpenAI Embeddings API (openai/gemini upstreams)
                 │  any-to-any translation (incl. SSE streaming) — M3–M6
                 ▼
            upstream provider
```

MVP plan + status: [`docs/plans/mvp-plan.md`](docs/plans/mvp-plan.md)

## Project docs (AI agents & humans)

- [`AGENTS.md`](AGENTS.md) — architecture, file map, conventions
- [`RULES.md`](RULES.md) — project rules (docs sync, frozen stack, secrets…)
- [`STATUS.md`](STATUS.md) — live state; the resume point after any interruption
- [`MEMORY.md`](MEMORY.md) — cross-session memory (decisions, lessons, preferences)


## Quickstart (local, no Cloudflare account needed)

```bash
cd khateway
npm install
openssl rand -base64 32   # → ENCRYPTION_KEY
cp .dev.vars.example .dev.vars   # then edit: ADMIN_PASSWORD + ENCRYPTION_KEY
npm run migrate:local    # create local D1 SQLite + apply migrations
npm run dev              # one-terminal dev: wrangler (:8787) + vite HMR (:5173)
```

Open <http://localhost:5173> → sign in with `ADMIN_PASSWORD` from `.dev.vars`.
UI edits hot-reload instantly; worker edits (`src/worker/**`) reload
automatically. `npm run dev:prod` serves the production-style built bundle on
:8787 instead.

- Add a provider (one or more adapters + base URL + API key). Vendors that
  speak both dialects (OpenRouter, LiteLLM, …) are ONE provider with both
  `OpenAI-compatible` and `Anthropic` checked — one shared base URL serves
  both, and Khateway picks the upstream dialect per request. Google Gemini
  can be registered either natively (`Gemini (native)` preset — the adapter
  builds `generateContent`/`streamGenerateContent` requests with thinking
  budgets and native multiparts, translating every client dialect) or through
  its OpenAI-compat endpoint (`Gemini (OpenAI-compat)` preset, openai
  adapter).
- Register models (slug → upstream model id, pricing, capabilities).
- Test connections from the Providers page.

## Pointing clients at the gateway

Every `/v1` request requires a valid client key — there is no keyless access.
Give clients a `khat-…` key as `Authorization: Bearer <key>` (OpenAI SDKs) or
`x-api-key: <key>` (Anthropic SDKs); anything else gets a 401
(`invalid_api_key`). Keys bring spend caps, model allow-lists, per-key logs
and prepaid balances. Onboarding paths:

- **CLI/TUI clients** (khode): device sign-in — the client mints a request at
  `POST /api/v1/device/code`, the user approves it at `/app/device`, and the
  client's poll returns a personal key.
- **Humans**: create keys in the portal (`/app` → Keys) or the admin console.

Model listing (`GET /v1/models` — includes per-model `pricing` and
`supported_parameters`) requires a key too.

**Client APIs (M16):** `GET /api/v1/auth/key` (aliases: `/api/v1/key`) returns
a key's label, spend limit and accrued usage; `GET /api/v1/credits` returns
the prepaid balance behind the key (personal or org). Both require a real
client key. Send `HTTP-Referer`/`X-Title` headers on `/v1` calls to have your
app attributed in the request logs; streaming responses carry keep-alive
comments and success responses carry `x-ratelimit-*` headers.

## Rate limiting (M10)

The gateway enforces request-rate limits by default — an open endpoint without
them is abuse bait. All windows are fixed **1-minute** counters stored in a
Durable Object (SQLite-backed, works on the Workers free plan), so limits hold
across all isolates and PoPs:

| Bucket | Applies to | Default | Configured via |
|---|---|---|---|
| per-key | requests carrying a valid `khat-` key | 120 req/min | Settings → Rate limiting (`rate_limit_key_rpm`), per-key override on each API key |
| per-IP | unused since keyless removal (kept in the limiter) | 60 req/min | Settings → Rate limiting (`rate_limit_ip_rpm`) |
| per-model | everyone, global per model slug | unlimited | `rate_limit_rpm` on each model |

Notes:

- Keyed requests never touch the IP bucket (a shared office egress IP must not
  punish a legitimate heavy key). With keyless removed, no live traffic hits
  the IP bucket; the bucket stays in the limiter for completeness.
- Exceeding a limit answers **429** with an integer `Retry-After` (seconds
  until the window rolls over) and the error envelope in the caller's dialect
  (`code: "rate_limit_exceeded"` / anthropic `type: "rate_limit_error"`).
  Rate-limited requests are logged like any other outcome.
- Disable everything with the **Rate limiting** toggle in Settings
  (`rate_limit_enabled: "off"`); a limiter outage fails open (requests keep
  flowing) rather than taking the gateway down.
- Fixed windows allow up to 2× the limit across a window boundary — the
  standard tradeoff, fine for abuse control.

## Semantic cache (M11)

The gateway can serve repeats of the **same text-only, non-streaming request**
from a local cache instead of hitting the upstream again. Opt-in on two
surfaces while the master switch is on:

| Switch | Meaning | Configured via |
|---|---|---|
| master | deployment-wide kill switch + entry lifetime | Settings → Semantic cache (`cache_enabled`, `cache_ttl_seconds`, default off / 3600 s) |
| per model | cache every eligible request to this model | `cache_enabled` on each model (Models page) |
| per key | cache every eligible request this key makes | `cache_enabled` on each API key (API Keys page) |

Notes:

- The cache key is a **sha-256 over the canonical request + model slug**, so
  the same conversation arriving through `/v1/chat/completions`,
  `/v1/messages` and `/v1/responses` hits the same entry — cross-dialect
  repeats are served translated, same-dialect repeats byte-identical.
- Eligible = text-only completions: no streaming, no tools/tool history, no
  images, `n` ≤ 1. Widen later, not silently.
- Cache hits are **logged and billed like any response** (`cache_hit` in
  request_logs, "cached" badge in the Logs UI, savings counted on the Overview
  and Settings cards) and still consume rate-limit budget.
- `x-khateway-cache: HIT` / `MISS` response headers report cache state on
  eligible requests.
- Admin **Flush cache** drops every entry immediately; expired entries are
  swept lazily on each store.

## UI hot-reload during development

`npm run dev` already runs both servers in one terminal (tagged `[worker]`/
`[ui]` logs, Ctrl-C stops both). Prefer separate terminals?

```bash
npm run dev:worker   # terminal 1 — wrangler on :8787 (worker edits auto-reload)
npm run dev:ui       # terminal 2 — Vite dev server on :5173, proxies /api /v1 /health
```

## Deploy to Cloudflare

```bash
npx wrangler d1 create khateway          # paste the returned database_id into wrangler.jsonc
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put ENCRYPTION_KEY # openssl rand -base64 32
npx wrangler d1 migrations apply khateway --remote
npm run deploy
```

## Milestones

| M | Scope |
|---|---|
| M1 ✅ | Scaffold, login/session, app shell |
| M2 ✅ | Providers & models CRUD, encrypted keys, connection tests |
| M3 ✅ | `/v1/chat/completions` + `/v1/models`, routing, openai adapter |
| M4 ✅ | Anthropic adapter, `/v1/messages`, cross-dialect SSE translation |
| M5 ✅ | `/v1/responses` |
| M6 ✅ | Tool calling + vision + fallback chains |
| M7 ✅ | Client API keys, request logs + cost, snippets (keyless default removed in session 29 — keys required, always) |
| M8 ✅ | User accounts + prepaid balances + Lemon Squeezy top-ups (`/app` portal, `/webhooks/lemonsqueezy`) |
| M9 ✅ | Orgs / teams: shared org balances, join-code invites, portal Teams page, admin Organizations |
| M10 ✅ | Gateway rate limiting: per-key / per-IP / per-model caps in a Durable Object, 429 + `Retry-After` |
| M11 ✅ | Semantic cache: opt-in per model/key, canonical-request hash key, TTL + admin flush, hits marked in logs |
| M12 ✅ | Native Gemini adapter: `generateContent` upstream (thinking budgets, native multiparts) — OpenAI-compat endpoint still available |
| M13 ✅ | `POST /v1/embeddings`: OpenAI Embeddings API face, openai-compatible + native-gemini upstreams, logged + priced like chat |
| M14 ✅ | Playground: in-admin chat tester over the real gateway via session-scoped client keys, streamed render + per-request log card |
| M15 ✅ | Pre-launch hardening: atomic webhook credit, log indexes + bounded sums, validation ordering, error scrub — and the real deploy |
| M16 ✅ | OpenRouter parity: /v1/models pricing + supported_parameters, /api/v1 key/credit APIs, legacy /v1/completions, attribution headers, x-ratelimit headers, SSE keep-alives |
| M17 ✅ | Reasoning/thinking end-to-end: anthropic thinking, openai reasoning_effort/reasoning_content, responses reasoning — translated across the full matrix |
| M18 ✅ | Structured outputs / JSON mode: response_format + text.format translated to openai, gemini (responseMimeType/responseSchema) and anthropic upstreams |

**MVP complete + M8–M18: public foundations, orgs, rate limiting, semantic cache, native Gemini, embeddings, playground, hardening + real deploy, OpenRouter parity, reasoning, structured outputs.**
See [`STATUS.md`](STATUS.md) for the verification baseline and
[`ROADMAP.md`](ROADMAP.md) for what's next.

## User portal (`/app`)

Khateway ships a self-serve user portal at [`/app`](http://localhost:5173/app):
email/password accounts (PBKDF2-hashed), per-user prepaid balances in
micro-USD with an auditable ledger, personal API keys, usage views, and
Lemon Squeezy hosted-checkout top-ups. Organizations/teams (M9) add shared org
balances, rotatable join-code invites, member roles, and org-scoped keys that
draw the org balance at the gateway — all manageable from the portal's Teams
page and the admin Organizations page. Public signup can be toggled in admin
Settings. Top-ups credit through `POST /webhooks/lemonsqueezy`
(signature-verified, idempotent); configure store/variant/API key/webhook
secret on admin Settings → Billing.

**Social sign-in (Google + GitHub)**: the login page leads with
"Continue with Google" / "Continue with GitHub" buttons (email/password stays
below as the fallback). Behind the scenes it is a plain OAuth 2.0
authorization-code flow on fetch — no SDKs. Account linking is
verification-gated: a provider-verified email matching an existing account
links to it; an unverified email never links (it can only create a fresh
account, and only while public signup is open). OAuth-only accounts have no
password; password login tells them to use the social buttons.

Operator setup (per provider, ~2 minutes):

1. **Google**: create an OAuth client at <https://console.cloud.google.com/apis/credentials>
   (type: Web application). Add
   `https://YOUR-HOST/api/portal/oauth/google/callback` as an authorized
   redirect URI.
2. **GitHub**: create an OAuth App at <https://github.com/settings/developers>.
   Set the homepage to your host and the authorization callback URL to
   `https://YOUR-HOST/api/portal/oauth/github/callback`.
3. Open **admin Settings → Social sign-in**, copy each displayed callback URL
   into the provider console (the URLs are also right there in the card),
   then paste each client id + client secret and Save. A provider becomes
   active the moment both values are saved; clearing the client id disables
   it again. Secrets are AES-256-GCM encrypted at rest and never returned by
   the API.

Verifying a real round-trip (browser + your own Google/GitHub account):

1. Sign out of the portal (or use a private window), open `/app/login` and
   click **Continue with Google** (then repeat with GitHub).
2. Approve the consent screen at the provider.
3. Expect to land back on `/app` signed in — first run creates the account
   (check admin → Users), second run signs the same account in again.
4. Device-flow tie-in: start `khode /login`, then click the social button from
   the verification link — after sign-in you land straight on
   `/app/device?code=…` to approve, because the OAuth flow preserves `next`.

**Device sign-in (RFC 8628)**: CLI/TUI clients like [khode](../khode) sign in
with `/login` — the terminal shows a short code at
[`/app/device`](http://localhost:5173/app/device), the signed-in user
approves, and the client receives a personal API key (visible and revocable
under Keys) for their balance. The social sign-in buttons ride along: a
first-time user can approve a device code without ever creating an
email/password account.

See [`docs/plans/mvp-plan.md`](docs/plans/mvp-plan.md) for the full plan.
