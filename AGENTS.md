# AGENTS.md — Khateway

Guide for AI agents (and humans) working on **Khateway**. Read this before changing anything.
Cross-session facts and history live in `MEMORY.md`; live work state in `STATUS.md`; roadmap + milestones in `ROADMAP.md`; rules in `RULES.md`.

## What this is

**Khateway** — a self-hosted AI model router, OpenRouter-style. Clients point any
OpenAI or Anthropic SDK at **one base URL**; Khateway authenticates the client
(client API key), resolves the requested `model` slug to a provider, **translates
between API dialects both ways**, forwards to the upstream provider with upstream
credentials, and streams the response back translated — while logging usage,
latency and cost per request.

The three dialects (M3–M6): `POST /v1/chat/completions` (OpenAI Chat),
`POST /v1/responses` (OpenAI Responses), `POST /v1/messages` (Anthropic).
Milestones M1–M7 done — **MVP complete** (admin console, gateway core, all three
dialects + cross-dialect translation, tools/vision, fallback chains & retries,
client API keys + spend caps + allowed-model lists, request logs + cost + logs UI,
SDK snippets). **M8 done** — public foundations: portal user accounts (`/app`
signup/login with PBKDF2 passwords + revocable sessions), per-user prepaid
balances (micro-USD ledger debited per request), Lemon Squeezy MoR top-ups
(hosted checkout + signature-verified idempotent webhook), user-scoped keys.
**M9 done** — multi-user orgs/teams: `orgs` + `org_members` (owner/member
roles, rotatable join-code invites), shared org balances drawn by org-scoped
keys, org usage/log/billing views in the portal Teams page, admin
Organizations page (global), request_logs user/org attribution.
**M10 done** — gateway rate limiting: per-key / per-IP (anonymous) /
per-model request caps in fixed 1-minute windows counted by a SQLite-backed
Durable Object (cross-isolate), 429 + `Retry-After` in the caller's dialect,
fail-open on limiter errors, ON by default (120 key / 60 IP rpm) — the
public-launch blocker is cleared.
**M11 done** — semantic cache: opt-in per model/key behind a master switch;
cache key = sha-256 of the canonical request + model slug (dialect-
independent); text-only completions only; TTL + admin flush; hits are logged
(`cache_hit`) and billed like any response.
**M12 done** — native Gemini adapter: third upstream dialect `gemini`
building `generateContent`/`streamGenerateContent?alt=sse` requests with
`x-goog-api-key` (thinking budgets via `reasoning_effort` → thinkingConfig,
native inlineData/fileData multiparts, name-bound tool calls/results);
responses normalize onto openai shapes and every client dialect translates
through the existing paths; the OpenAI-compat Gemini endpoint stays
available as a plain openai-adapter provider.
**M13 done** — embeddings: `POST /v1/embeddings` (OpenAI Embeddings API —
the only embeddings client face) routes to openai-compatible `/embeddings`
(response relayed, JSON usage watcher) or native Gemini `:embedContent`/
`:batchEmbedContents` (normalized onto the openai shape; usageMetadata
tokens logged), sharing the chat pipeline's auth/gates/fallbacks/logging/
balance debit; anthropic-only providers answer 501; no semantic cache
(chat-shaped eligibility gate — deliberate).
**M14 done** — playground UI: in-admin chat tester (`/playground`) hitting
the REAL gateway with a session-scoped client key (`api_keys.playground_session`
= sha256 of the admin session token; `POST /admin/playground/key` rotates +
mints — raw key returned once — hidden from the keys list, deleted at logout,
swept when the session row dies); model picker, SSE streaming render,
resulting log rows shown per request. The stated post-MVP order is exhausted.
**Keyless-native default** (khode integration): /v1 is served
anonymously unless `client_key_enforcement` is switched on (admin settings).

## Stack (deliberate choices — do not churn)

| Layer | Choice | Why |
|---|---|---|
| Runtime | Cloudflare Workers (Hono 4) | zero-ops deploy, native SSE streaming, cheap |
| DB | D1 (SQLite) + drizzle-orm + drizzle-kit | typed queries, migrations via wrangler |
| Admin UI | React 19 + Vite 8 + Tailwind 4 + TanStack Query 5 | served as static assets by the same Worker |
| Rate limiting | Durable Object `RATE_LIMITER` (SQLite-backed class) | cross-isolate fixed-window counters; no D1 write per request; free-plan compatible |
| Router/UI kit | hand-rolled (`src/web/router.tsx`, `components/ui.tsx`) | tiny; no react-router/shadcn — deliberate |
| Icons | lucide-react | small, tree-shaken |
| TS | strict, three tsconfigs (worker: workers-types only, web: DOM, test: worker + node types) | keeps runtime globals honest |
| Tests | vitest golden fixtures (`npm test`, offline) + smoke scripts (need dev server) | fixtures pin wire behavior; smoke covers D1/HTTP orchestration |
| Secrets | `.dev.vars` locally, `wrangler secret put` remotely | ENCRYPTION_KEY = 32B base64 (AES-256-GCM) |

## File map

```
src/shared/
├── adapters.ts     — Adapter type + KNOWN_ADAPTERS (dep-free, worker+web import)
├── vendor-urls.ts  — well-known vendor base-URL presets for the provider form
src/worker/
├── index.ts        — Hono entry: mounts /admin + /v1 + /app/api + /webhooks, /health, notFound/onError
├── env.ts          — Env bindings type, KNOWN_ADAPTERS, DEFAULT_BASES per adapter,
│                     joinUrl + joinAdapterUrl (per-adapter URL shape for shared bases)
├── crypto.ts       — AES-256-GCM secret encrypt/decrypt, HMAC sign/verify, sha256, safe-equal,
│                     PBKDF2-SHA-256 password hash/verify (versioned format; M8)
├── auth.ts         — admin session create/validate/revoke (DB-backed), adminAuth, bucketed login rate limit (per-isolate),
│                     client API key generate/verify (sha-256 lookup; M7),
│                     user sessions + portalAuth middleware (M8; cookie khateway_user)
├── canonical.ts    — types-only canonical chat request (the dialects/adapters contract)
├── routing.ts      — `model` slug / `provider/slug` pin → (model, provider) candidate (+pricing, fallback chain)
├── billing/
│   ├── config.ts        — MoR billing config rows in `settings` (LS store/variant ids plain,
│   │                      API key + webhook secret AES-256-GCM encrypted; M8)
│   └── lemonsqueezy.ts  — X-Signature HMAC verify, webhook payload parse + credit math,
│                          hosted-checkout builder (custom_price + custom.user_id; M8)
├── ratelimit/
│   ├── do.ts            — RateLimiterDO (M10): singleton cross-isolate counter, SQLite-backed
│   │                      fixed 1-minute windows (`INSERT … ON CONFLICT … RETURNING`), plain ES
│   │                      class + internal `POST /check` fetch protocol (no cloudflare:workers import)
│   └── client.ts        — buildGatewayRateChecks (pure, golden-tested) + checkRateLimits
│                          (one DO round-trip, fail-open → null on any error)
├── cache/
│   ├── key.ts           — M11 pure half: stableStringify (key-sorted JSON) + cacheKeyInput +
│   │                      buildCacheKey (sha-256 over canonical request + model slug) +
│   │                      evaluateCacheEligibility (text-only gate: no stream/tools/history/vision/n>1)
│   └── store.ts         — M11 D1 half: lookupCacheEntry (fail-open), storeCacheEntry (waitUntil
│                          insert + expired-row sweep + 200-with-error-body guard + 512 KB cap),
│                          flushCache, cacheStats (entries/bytes + 24 h hits/token savings)
├── db/
│   ├── schema.ts   — drizzle: providers, models(+rate_limit_rpm,+cache_enabled), api_keys(+user_id,
│   │                 +org_id,+rate_limit_rpm,+cache_enabled,+playground_session M14),
│   │                 request_logs(+user_id,+org_id,
│   │                 +cache_hit), sessions, user_sessions, users, orgs, org_members,
│   │                 balance_entries(+org_id, user_id nullable — exactly one of the two),
│   │                 webhook_events, settings, cache_entries (M11)
│   ├── index.ts    — getDb(env)
│   └── settings.ts — deployment flags (client_key_enforcement, public_signup,
│                      rate_limit_enabled/key_rpm/ip_rpm — M10) in one 5 s cached snapshot,
│                      fail-open on read errors
├── dialects/
│   ├── openaiChat.ts        — client OpenAI dialect: parse→canonical, OpenAI error envelope,
│   │                          upstream-error mapping, anthropic→openai response/SSE translation
│   ├── anthropicMessages.ts — client Anthropic dialect: parse→canonical, anthropic error envelope,
│   │                          upstream-error mapping, openai→anthropic response/SSE translation
│   ├── openaiResponses.ts   — client Responses dialect: parse→canonical, openai/anthropic →
│   │                          Responses objects + events (JSON + SSE) translation
│   ├── openaiEmbeddings.ts  — M13 client Embeddings dialect (/v1/embeddings): parse→canonical
│   │                          (input string|string[], dimensions, encoding_format; token
│   │                          arrays rejected), the first non-chat client face
│   ├── gemini.ts            — M12 upstream Gemini vocabulary: gemini JSON/SSE → openai shapes
│   │                          (the gateway reuses the openai→X translators from there) +
│   │                          Google error-envelope mapping; M13 adds embeddings normalization
│   │                          (geminiEmbeddingsToOpenAi + floatsToBase64)
│   ├── options.ts           — shared option validators for the dialect parsers
│   ├── sse.ts               — generic text/event-stream framing shared by SSE translators
│   └── usage.ts             — M7 usage extraction from upstream JSON/SSE (tee-branch watcher for
│                              logs; M12 adds gemini usageMetadata — thoughts bill as output)
├── adapters/
│   ├── base.ts      — shared adapter plumbing: key decrypt, header merge, invoke w/ header-timeout
│   ├── openai.ts    — openai-compatible upstream: canonical → /chat/completions request
│   │                 (+ M13 buildOpenAiEmbeddingsRequest → /embeddings)
│   ├── anthropic.ts — anthropic upstream: canonical → /v1/messages request (system folding, etc.)
│   └── gemini.ts    — M12 gemini upstream: canonical → models/{model}:generateContent(:streamGenerateContent
│                      ?alt=sse) with x-goog-api-key (systemInstruction folding, name-bound
│                      functionResponse, inlineData/fileData multiparts, thinkingConfig budgets)
│                      (+ M13 buildGeminiEmbeddingsRequest → :embedContent/:batchEmbedContents)
└── routes/
    ├── admin.ts    — login/logout (logout deletes the session's playground key), overview (+24h
    │                 usage), providers CRUD + test, models CRUD,
    │                 api-keys CRUD (M7: raw key returned once; M8/M9 DTOs add user_id/user_email
    │                 + org_id/org_name; M14: list excludes playground keys),
    │                 playground key mint (M14: POST /playground/key — rotate + mint a
    │                 session-scoped key, sweep orphaned/expired-session playground keys),
    │                 users list/adjust-balance/enable/delete (M8; M9 delete
    │                 runs org-owner succession), orgs list/patch/delete (M9, global),
    │                 billing config GET/PATCH (M8), settings GET/PATCH (enforcement +
    │                 public_signup), logs list/clear (M7; DTO carries user/org attribution),
    │                 upstream model discovery + bulk import (fetch-models ×2, import-models)
    ├── gateway.ts  — /v1 pipeline: client-key auth middleware + spend cap + allowed-models (M7)
    │                 + prepaid-balance gate + usage debit (M8 personal / M9 org balance),
    │                 + rate limits after routing (M10: per-key / per-IP anonymous / per-model,
    │                 429 + Retry-After in the caller's dialect),
    │                 dialect×adapter matrix (/chat/completions, /responses, /messages),
    │                 M13 embeddings branch (/embeddings — shared gates via enforceSpendCap +
    │                 enforcePostRoutingGates helpers), request_logs writes with user/org
    │                 attribution + tee-based usage capture, /models(/:id), 404 wildcard
    ├── portal.ts   — /app/api user portal (M8): signup/login/logout/me (public signup flag),
    │                 PERSONAL keys CRUD (+usage/billing — org keys excluded via isNull(orgId)),
    │                 balance + ledger entries, LS checkout URLs
    ├── orgs.ts     — /app/api/orgs (M9): list/create/join/leave, detail (+members, owner-only
    │                 join_code, rotate), member role/remove (last-owner guard), org keys CRUD
    │                 (owner-any / member-own), org usage, org billing + owner-only LS checkout
    └── webhooks.ts — /webhooks/lemonsqueezy (M8): HMAC-verified MoR callbacks, two-layer
                       idempotent balance credit (webhook_events + balance_entries.ref unique;
                       M9: custom_data.org_id credits the org, wins over user_id)

src/web/
├── main.tsx        — QueryClient + root render (+ Toaster)
├── App.tsx         — sidebar shell (admin), portal routes (/app*), unauth redirects, 404
├── router.tsx      — tiny history-API router (navigate / useRoute / Link)
├── api.ts          — typed admin client + DTO types + ApiError (401 → redirect)
├── portal-api.ts   — typed /app/api client + PortalError (401 → /app/login redirect event)
├── components/ui.tsx — Button/Input/Select/Switch/Badge/Card/Modal/Toast/fmt helpers
└── pages/          — Login.tsx, Overview.tsx, Providers.tsx, Models.tsx,
                      Playground.tsx (M14: chat tester — model picker, streaming SSE
                      render, session key badge, request-log card),
                      ApiKeys.tsx (M7: keys CRUD + one-time reveal + SDK snippets),
                      Logs.tsx (M7: filterable request logs, refresh, clear),
                      admin/Users.tsx + admin/Settings.tsx (M8: accounts + billing config),
                      admin/Orgs.tsx (M9: global orgs table, edit/rename + ledgered balance
                      adjust, enable toggle, delete — with counts + join code),
                      portal/ (M8: PortalLogin, PortalShell, PortalDashboard, PortalKeys;
                      M9: PortalTeams — org list/create/join + per-org members, invite
                      code, keys, usage, billing)

scripts/dev-all.mjs        — `npm run dev`: one-terminal hot-reload runner (wrangler dev
                            + vite, tagged output, clean Ctrl-C shutdown, no deps)
scripts/smoke.mjs          — end-to-end admin API test against wrangler dev :8787
scripts/smoke_gateway.mjs  — /v1 pipeline test incl. a local mock upstream speaking BOTH dialects
                            + a native gemini face (self-cleaning fixtures; asserts the cross-dialect
                            matrix incl. the M5 /v1/responses cells + dual-adapter providers + model
                            discovery/import + the M12 native-gemini matrix + the M13 embeddings
                            branch — 176 checks as of 2026-09-19)
scripts/smoke_m8.mjs       — accounts/balance/webhook e2e vs wrangler dev :8787 (signup → credit →
                            debit math → 429 → signed LS webhook → idempotency; 42 checks)
scripts/smoke_m9.mjs       — orgs/teams e2e vs wrangler dev :8787 (2 orgs coexist, join codes,
                            roles + last-owner guards, key scoping, org debits at the gateway,
                            log attribution, org webhook credit, admin succession; 74 checks)
scripts/smoke_m10.mjs      — rate limiting e2e vs wrangler dev :8787 (concurrent bursts per
                            bucket: anonymous IP, key default/override/independence, global
                            model cap, Retry-After + both dialect 429 envelopes, disabled
                            bypass, 429 log rows; settings restored off; 33 checks)
scripts/smoke_m11.mjs      — semantic cache e2e vs wrangler dev :8787 (call-counting mock upstream:
                            miss→hit, cross-dialect hits on one entry, streams/tools/non-opted
                            bypass, key opt-in + shared cache, master off, TTL expiry, flush,
                            logs cache_hit + exact priced cost, 24 h stats; 30 checks)
scripts/smoke_m14.mjs      — playground e2e vs wrangler dev :8787 (mint 401 unauth + key shape +
                            hidden from keys list, /v1/models + streamed call with include_usage
                            through the key, log row with exact cost + 'Playground' attribution,
                            re-mint rotation 401 under enforcement, logout revokes the session
                            key, fresh session works; enforcement restored off; 24 checks)
drizzle/            — generated SQL migrations (applied with wrangler d1 migrations apply)
                      (0005_m9_orgs adds orgs, org_members, api_keys.org_id,
                      request_logs.user_id/org_id, balance_entries.org_id + nullable user_id;
                      0006_m10_rate_limits adds models.rate_limit_rpm + api_keys.rate_limit_rpm;
                      0007_m11_cache adds models/api_keys.cache_enabled, request_logs.cache_hit,
                      the cache_entries table + expires/model indexes;
                      0008_m14_playground adds api_keys.playground_session;
                      0009_m15_log_indexes adds request_logs_api_key_idx)

tests/              — offline golden-fixture suite (vitest; no server needed)
├── fixtures/       — arrays of {name, …input, expected} cases per wire-format area
│                     (parsers ×3, adapters incl. gemini-adapter, JSON translation ×4 +
│                     gemini-translation, SSE translation ×4 flows + gemini-sse,
│                     upstream-error mapping, usage/cost, SSE framing, vendor URL presets,
│                     LS webhook parsing/credit math, M10 rate-check buckets,
│                     M11 cache-key projections + eligibility gates,
│                     M13 embeddings-adapter + embeddings-openai [parse + normalize])
└── worker/         — thin runners + helpers (fixture loader, SSE wire serializer/parser,
                        timestamp freezer, RoutingCandidate builder; runtime key encryption)
                        + password.test.ts, billing.test.ts (inline/fixture hybrid),
                        + gemini.test.ts (M12 JSON/SSE normalize + error goldens),
                        + embeddings.test.ts (M13 adapter/parse/normalize goldens),
                        + rate-limit.test.ts (builder goldens + real RateLimiterDO.fetch
                        against a fake SqlStorage)
```

## Architecture notes (important)

- **One deployable**: the Worker serves the built SPA from `web-dist/` (asset
  binding) and handles API paths. `run_worker_first` covers `/v1`, `/v1/*`,
  `/admin`, `/admin/*`, `/app/api`, `/app/api/*`, `/webhooks`, `/webhooks/*`,
  `/health` — everything else is static assets with SPA fallback (admin at
  `/…`, user portal at `/app…`).
- **Admin auth**: `POST /admin/login` compares `ADMIN_PASSWORD` (constant-time),
  sets an HttpOnly HMAC-signed cookie **and** stores `sha256(token)` in the
  `sessions` table — every request validates signature + expiry + DB row so
  logout truly revokes. Never downgrade to stateless-only tokens.
- **Upstream model discovery + import**: `POST /admin/providers/fetch-models`
  (unsaved add-form: probes with form values, in-memory key only) and
  `POST /admin/providers/:id/fetch-models` (saved provider: stored key)
  normalize the upstream `/models` listing (openai path per base_url shape,
  anthropic `/v1/models`, gemini `/v1beta/models` — strips the `models/`
  prefix, maps inputTokenLimit/outputTokenLimit, skips non-generateContent
  entries) into `{models:[{id,display_name,context_window,max_output_tokens}]}`
  (cap 500, deduped by id). `POST /admin/providers/:id/import-models` creates
  one model per id (slug = upstream id, upstream_model = id), dedupes input,
  skips existing slugs + ids outside the slug alphabet (reported in `skipped`),
  max 100 per call. UI: provider modal "Fetch models" button + checkbox picker
  + Import (add mode auto-creates the provider first).
- **Multi-adapter providers**: `providers.adapters` is a JSON array of upstream
  dialects (`["openai"]`, `["anthropic"]`, or both for dual-dialect endpoints
  like OpenRouter/LiteLLM/AI Gateway — ONE provider row, one shared base URL).
  The gateway picks the adapter per request (client-dialect match first) and
  retries the SAME provider through its other adapter when the first pick
  cannot express the request (e.g. `n>1`, assistant-first) before consuming
  any fallback. `joinAdapterUrl`  strips a trailing `/v1` for anthropic paths
  and inserts `/v1` for openai paths on bare origins — one base URL serves
  both adapters whether the user pasted it with or without `/v1` (pinned by                        tests/worker/join-adapter-url.test.ts; the provider-form presets in
                        `src/shared/vendor-urls.ts` satisfy the same rule).
- **stream_options.include_usage (openai chat dialect)**: parsed into canonical
  `streamIncludeUsage`, re-emitted by the openai adapter for streaming requests
  (same-dialect passthrough), and honored by the anthropic→openai SSE
  translator (a final usage-only chunk with `choices: []` instead of usage on
  the finish chunk) when the client asked for it. Not forwarded for translated
  request paths (anthropic upstreams have no such param).
  Admin API accepts
  `adapters` (array) and legacy `adapter` (string) on create/patch; DTOs
  expose both (`adapters` array + `adapter` scalar = first).
- **Gateway auth (M7, amended keyless-native)**: client-key enforcement is
  OPT-IN via the `settings` row `client_key_enforcement` (`GET/PATCH
  /admin/settings`; TTL-cached 5 s per isolate — anonymous requests cost no key
  DB lookup). Default off: no-auth requests, the literal `anonymous` sentinel
  (khode's keyless mode, Bearer or x-api-key) and unknown tokens are all served
  anonymously; enrolled keys still get caps/allow-lists/log attribution.
  Enforcement on: valid enabled `Authorization: Bearer khat-…` or `x-api-key`
  required (khode users set `KHATEWAY_API_KEY`); anything else → 401 in the
  path's error dialect. Keys are stored as sha-256 hashes only (raw shown once
  at creation). Per-key spend caps (429 `insufficient_quota`) and allowed-model
  lists (403 `permission_error`) are enforced in the chat pipeline whenever a
  key resolved.
- **Request logs (M7)**: every chat-pipeline request writes one
  `request_logs` row (status, latency, tokens in/out, cost snapshot, truncated
  error; `api_key_id` null for anonymous requests). Streamed responses tee the upstream body into `dialects/usage.ts` so
  usage lands after the stream ends (`waitUntil`); logs never carry client
  bodies or headers.
- **Portal accounts + prepaid balance (M8)**: users self-serve at `/app`
  (email/password; `public_signup` setting default 'on' — magic link and email
  verification deferred, no email sender on Workers). Passwords are PBKDF2-
  SHA-256 (100k iterations, format `pbkdf2-sha256:<iters>:<salt>:<hash>` —
  verify honors the stored count so cost can rise later). User sessions are
  HMAC-signed cookie `khateway_user` (30 d) + `user_sessions` rows — logout and
  admin-disable revoke server-side; disabling a user kills their sessions.
  `api_keys.user_id` (null = admin-managed key) scopes portal key CRUD;
  portal users see only their own keys and set no spend limits (the balance
  governs). Balance is `users.balance_usd_micros` (integer micro-USD) with an
  auditable `balance_entries` ledger (topup/usage/adjustment; `ref` unique —
  `lemonsqueezy:order:<id>` / `log:<log-id>` / `adjustment:<uuid>` — makes
  replays impossible). Gateway: user-owned keys are refused at balance ≤ 0
  with 429 `insufficient_quota` (same envelope as the M7 spend cap; soft —
  concurrent requests may push slightly negative); the request's cost debits
  the balance in the same `waitUntil` path that records usage (null cost —
  unknown pricing or missing usage — never debits).
- **Lemon Squeezy billing (M8)**: config lives in `settings` (`ls_store_id`,
  `ls_variant_id`, AES-256-GCM `ls_api_key_enc`, `ls_webhook_secret_enc`) via
  `GET/PATCH /admin/billing/config` (secrets exposed only as hints/set-flags).
  `POST /app/api/billing/checkout {amount_usd}` (1–500) creates a hosted
  custom-price checkout with `checkout_data.custom.user_id` and returns its
  URL. `POST /webhooks/lemonsqueezy` verifies HMAC-SHA256 (`X-Signature`, hex,
  over the raw body), records every delivery in `webhook_events` (unique
  source+event_key = `<event>:<id>`; duplicates answer `{ok,duplicate}`), and
  credits `order_created` paid non-refunded orders by subtotal − discount
  (fallback: total) — MoR keeps the tax. All non-crediting outcomes are
  recorded with a note and answered 200 so LS never retry-loops; bad
  signature → 401. Test coverage: golden fixtures for parse/credit math +
  `scripts/smoke_m8.mjs` end-to-end (42 checks; unique order ids per run —
  webhook_events rows accumulate as the audit trail).
- **Orgs / teams (M9)**: `orgs` + `org_members` (roles `owner` | `member`;
  last-owner guard on demote/remove; owners cannot leave). Invites are
  rotatable join codes (no email sender on Workers); join is rate-limited
  per USER (`org-join:<uid>` bucket — per-user beats per-IP: authenticated
  surface, and smoke suites sharing one local IP never starve each other).
  Org-scoped keys (`api_keys.org_id`, creator kept in `user_id`) draw the
  ORG's shared prepaid balance (`orgs.balance_usd_micros`) at the gateway —
  the personal M8 user-balance path is untouched, and `debitBalanceUsage`
  debits exactly one of user/org. Portal personal surfaces (`/keys`,
  `/usage`, `ownKey`) exclude org keys via `isNull(orgId)`. Org API lives in
  `routes/orgs.ts` under `/app/api/orgs*`; non-members and unknown orgs both
  get 404 (no existence leak). LS checkouts carry `custom.org_id` and the
  webhook credits the org when it rides (org_id wins over user_id). Admin
  stays GLOBAL: `/admin/orgs` (rename/enable/ledgered-adjust/delete);
  deleting a user promotes the longest-tenured remaining member in each of
  their orgs (memberless orgs die with keys + ledger). `request_logs.user_id`
  + `.org_id` attribute every request (dangling ids after deletion, audit
  trail preserved).
- **Gateway rate limiting (M10)**: every chat-pipeline request, AFTER routing
  resolves the model, increments fixed 1-minute counters in the singleton
  `RateLimiterDO` ("global", SQLite-backed — `new_sqlite_classes` in
  wrangler.jsonc so the Workers free plan works; a D1 counter was rejected:
  +1 D1 write per request). Buckets per request (ONE DO round-trip, all
  checks incremented even when another denies): keyed → `key:<id>` at the
  key's `rate_limit_rpm` override or the settings default (120); anonymous →
  `ip:<cf-connecting-ip>` at 60 (keyed requests never touch the IP bucket);
  model with `models.rate_limit_rpm` → global `model:<slug>`.
  `rate_limit_enabled: 'off'` → zero checks. 429s use the path's error
  dialect + integer `Retry-After` (max window reset; the message names the
  binding constraint = max count/limit) and are logged like any outcome.
  Fail-open everywhere: limiter error → request served; settings read error
  → limits off until the 5 s cache expires. Login/signup buckets
  (`loginAllowed`) remain per-isolate memory — deliberate, queued as polish.
- **Semantic cache (M11)**: opt-in per model (`models.cache_enabled`) OR per
  key (`api_keys.cache_enabled`) while the `cache_enabled` master setting is
  'on' (default off; `cache_ttl_seconds` 1–2592000, default 3600). Cache key =
  sha-256 over a key-sorted stable JSON of the CANONICAL request + resolved
  model slug — dialect-independent (one entry serves /chat/completions,
  /messages and /responses; pinned and unpinned requests share the entry;
  stream/streamIncludeUsage excluded). The entry stores the RAW upstream JSON
  body + which adapter produced it; on a hit the payload is replayed through
  the exact same `respondTranslated` path a miss would take (same-dialect
  passthrough stays byte-identical; cross-dialect hits translate), so cached
  responses are indistinguishable apart from `x-khateway-cache: HIT|MISS`
  (emitted only on cache-eligible requests). Eligibility (text-only): no
  streaming, no tools/tool history, no images, n ≤ 1 — widen via
  `evaluateCacheEligibility` only. All gates (spend cap, rate limits,
  allow-list, balance) run BEFORE the lookup; hits still consume rate-limit
  budget, log `request_logs.cache_hit=1` with usage + cost from the stored
  payload (pricing follows the REQUESTED model), and debit like any response.
  Store path: `Response.clone()` → waitUntil read (≥512 KB, non-JSON or
  200-with-`error`-body payloads are skipped) → INSERT + expired-row sweep in
  one D1 batch, `onConflictDoNothing`. Fail-open everywhere: lookup error =
  miss, store error = logged. Admin: `GET /admin/cache` (entries/bytes/24 h
  hits/cached tokens), `POST /admin/cache/flush`. Settings UI card, Models +
  ApiKeys toggles, Logs "cached" badge, Overview cached count. Portal/org key
  DTOs expose `cache_enabled` read-only.
- **Native Gemini adapter (M12)**: `gemini` is a third UPSTREAM adapter —
  never a client dialect, so every gemini pairing is translated. The adapter
  (`adapters/gemini.ts`) builds `POST {base}/models/{upstream}:generateContent`
  (streaming: `:streamGenerateContent?alt=sse` — the ENDPOINT encodes
  streaming; the body has no `stream`/`model` fields, the model rides the
  URL path) with `x-goog-api-key` auth. Request translation: system/developer
  → `systemInstruction`, user/assistant → user/model roles with same-role
  merging (functionResponse parts lead user turns), tool calls →
  `functionCall{name,args:object}`, tool results → `functionResponse{name,
  response:object}` bound by tool NAME (resolved from the assistant turn's
  calls — Gemini has no call ids), images → `inlineData` (data URLs) /
  `fileData` (https), `reasoning_effort` extras →
  `generationConfig.thinkingConfig.thinkingBudget` (minimal 0 / low 1024 /
  medium 8192 / high 24576; `thinking.budget_tokens` clamped 0–32768).
  Assistant-first and n>1 are rejected `untranslatable_request` (dual-adapter
  providers retry). Responses (`dialects/gemini.ts`) NORMALIZE onto openai
  chat shapes — `geminiCompletionToOpenAi` + `transformGeminiSseToOpenAi`
  (tool_calls with synthesized `call_gemini_<n>` ids, finish_reason
  `tool_calls` when calls are present, promptFeedback blocks → content_filter)
  — and the gateway then serves every client face through the EXISTING
  openai-upstream cells (openai client = passthrough of the normalized body;
  anthropic/responses = existing translators). Usage:
  `usageMetadata.promptTokenCount` → in, `candidatesTokenCount +
  thoughtsTokenCount` → out (thinking bills as output; Google's total =
  prompt + thoughts + candidates). Errors: `geminiErrorToOpenAi` maps the
  Google `{error:{code,message,status}}` envelope (status string → openai
  type, kept in `code`). URL rule: `DEFAULT_BASES.gemini =
  https://generativelanguage.googleapis.com/v1beta`; `joinAdapterUrl`
  inserts `/v1beta` on BARE origins (mirrors the openai rule), pasted paths
  stay verbatim, the anthropic `/v1`-strip does NOT apply. Adapter pick: no
  client-dialect match → the provider's FIRST DECLARED adapter (lets
  `[gemini, openai]` providers serve anthropic/responses clients natively;
  no change for pure openai/anthropic providers). Cache: gemini entries
  store the RAW payload with upstream='gemini' and replay through the same
  normalization. Admin: test-connection probes `/v1beta/models`; discovery
  strips `models/` prefixes and skips non-generateContent entries. The
  OpenAI-compat Gemini endpoint (preset) remains a plain openai-adapter
  provider — both registration paths are valid.
- **Embeddings (M13)**: `POST /v1/embeddings` is the first NON-chat pipeline
  branch — it speaks the OpenAI Embeddings API (the only embeddings client
  face; Anthropic has none), parsed by `dialects/openaiEmbeddings.ts` into
  `CanonicalEmbeddingsRequest` (input normalized to `string[]`,
  `dimensions`/`encoding_format` validated, pre-tokenized integer arrays
  rejected 400, unknown fields ride `extras`). Upstreams: openai-compatible
  `POST {base}/embeddings` (response RELAYED untouched; usage via the JSON
  tee-watcher — `usage.prompt_tokens` → tokensIn) and native Gemini
  `:embedContent` (single) / `:batchEmbedContents` (arrays), normalized by
  `geminiEmbeddingsToOpenAi` (base64 encoding_format packs floats client-side
  via `floatsToBase64` — little-endian float32; gemini
  `usageMetadata.promptTokenCount` feeds both the response usage and the log
  row). The pipeline SHARES the chat gates: the M13 extraction moved spend
  cap / rate limits / allow-list / balance into `enforceSpendCap` +
  `enforcePostRoutingGates` helpers called by BOTH pipelines (chat behavior
  unchanged), so client-key auth, spend caps, rate limits, allow-lists and
  personal/org balances + debits apply with zero new gate code. The fallback
  chain walks like chat (429/5xx/timeout/network fall through; client 4xx
  surface; `x-khateway-attempts` spans adapter + fallback tries); adapter
  order is openai first (client-face match → passthrough), then gemini;
  anthropic-only providers answer 501 `upstream_dialect_unsupported`.
  `request_logs.dialect` = 'embeddings' (plain text column — no migration);
  tokensOut stays null (no output tokens) and cost = tokensIn ×
  `pricing_input` only — set input pricing on embedding models. NO semantic
  cache (M11's eligibility gate is chat-shaped; widen deliberately if ever
  needed). Errors are always openai-envelope shaped.
- **Playground (M14)**: the admin console's chat tester calls the REAL /v1
  gateway (openai chat dialect, SSE, `stream_options.include_usage`) with a
  SESSION-SCOPED client key so the request exercises the same
  auth/rate-limit/fallback/logging path as any external client. Key
  lifecycle: `api_keys.playground_session` = sha256 of the admin session
  token (nullable — null = normal key). `POST /admin/playground/key`
  (adminAuth) ROTATES: deletes the session's previous key, sweeps playground
  keys whose session row is gone/expired (leftJoin on `sessions`), mints a
  fresh key (name 'Playground', no spend cap, no allow-list) and returns the
  raw key ONCE. Hidden from `GET /admin/api-keys`
  (`isNull(playgroundSession)`); deleted at `POST /admin/logout`; the web
  client dedupes concurrent mints with a shared inflight promise (React
  StrictMode double-mount must share one key — mint = rotate). The page
  polls `GET /admin/logs?api_key_id=<key>` after each completion (log rows
  land in waitUntil after the stream ends). Gateway code is UNTOUCHED — a
  playground key is an ordinary enrolled key and satisfies enforcement.
- **Rate limiting (login surfaces)**: `loginAllowed(bucket, ip)` — separate
  per-isolate buckets `admin` / `portal-login` (10/min) and `portal-signup`
  (20/min; only validated attempts consume it), so one surface's burst never
  locks the other. Org-join (M9) is keyed per user id. This is NOT the M10
  gateway rate limiting (shipped — see the Gateway rate limiting note above).
- **API keys**: provider keys are AES-256-GCM-encrypted (`v1.<iv>.<ct>`), never
  returned by the API (only `key_hint` = last 4). Client keys (M7) are stored
  as sha-256 hashes only.
- **DTO convention**: DB rows are camelCase; all JSON responses are snake_case.
- **Module boundaries (in force)**: wire-format/dialect logic lives ONLY in
  `src/worker/routes/gateway.ts`, `src/worker/dialects/`, `src/worker/adapters/`
  (canonical model in `canonical.ts`, routing in `routing.ts`);
  DB access via drizzle in `db/`; crypto only in `crypto.ts`. Do not scatter
  OpenAI/Anthropic parsing elsewhere.
- **Fallback chains (M6)**: `runChatPipeline` walks `primary + models.fallbacks`
  (`routing.ts` → `resolveModelChain`; entries may be `provider/slug` pins, dead
  entries skipped) and fails over on 429/5xx/timeout/network; client 4xx surface
  immediately; `x-khateway-attempts` reports the 1-based chain position.

## Build & run

```bash
npm install              # node 20+
npm run migrate:local    # create local D1 + apply drizzle migrations
npm run dev              # DEFAULT: one-terminal hot-reload dev (scripts/dev-all.mjs):
                         #   wrangler dev :8787 + vite :5173, tagged [worker]/[ui]
                         #   output, Ctrl-C stops both, builds web-dist once if missing
                         # → browse http://localhost:5173 for UI work
npm run dev:prod         # production-style dev: builds SPA, wrangler dev on :8787
                         # (serves the built bundle; UI edits need a rebuild)
npm run dev:ui           # Vite hot-reload dev server on :5173 (proxies to :8787)
npm run dev:worker       # wrangler dev only (worker edits auto-reload)
npm run check            # tsc for worker + web + test configs
npm test                 # golden-fixture suite (offline; no dev server needed)
npm run test:watch       # vitest watch mode
npm run deploy           # build SPA + wrangler deploy (needs real database_id + secrets)
node scripts/smoke.mjs          # while `npm run dev` runs
npm run smoke:gateway           # /v1 pipeline via local mock upstream, while `npm run dev` runs
npm run smoke:m8                # accounts/balance/webhook e2e, while `npm run dev` runs
npm run smoke:m9                # orgs/keys/org-balance/webhook e2e, while `npm run dev` runs
npm run smoke:m10               # rate limiting e2e (concurrent bursts), while `npm run dev` runs
npm run smoke:m11               # semantic cache e2e, while `npm run dev` runs
npm run smoke:m14               # playground e2e (session-scoped keys + streamed round-trip), while `npm run dev` runs
```

Schema changes: edit `src/worker/db/schema.ts` → `npm run generate` →
`npm run migrate:local` (local) / `wrangler d1 migrations apply khateway --remote`.

## Data written at runtime

- D1: providers, models, api_keys, request_logs, sessions, settings, users,
  user_sessions, balance_entries, webhook_events, orgs, org_members,
  cache_entries (cloud/local via wrangler state)
- DO storage: `RateLimiterDO` SQLite `counters` (M10 fixed-window buckets,
  self-evicting)
- `.dev.vars` — local secrets only, gitignored, never commit
- `web-dist/` — build output (gitignored); regenerable, never hand-edit

## Conventions

- English identifiers/comments; responses in the user's language.
- Admin API errors are always `{ "error": "message" }` with proper HTTP status.
- Validation happens server-side in `routes/admin.ts`; the SPA is convenience, not authority.
- UI styling = Tailwind utilities only; palette: zinc neutrals + emerald accent;
  shared primitives live in `components/ui.tsx` — don't scatter one-off styles.
- Zero `any` policy in worker code; precise types for crypto buffers
  (`Uint8Array<ArrayBuffer>` at importKey boundaries).

## Docs sync rule

While working, keep `STATUS.md` current (also on interruption — write WIP state
before stopping). After completing any task, update `STATUS.md` + `MEMORY.md`
(and `AGENTS.md` if the map above changed). See RULES.md. Non-negotiable.
