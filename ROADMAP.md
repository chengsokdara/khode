# ROADMAP.md — Khateway roadmap

Last updated: 2026-09-19 (session 20). STATUS.md keeps live state only and
points here.

## Where we are

**MVP M1–M7 ✅ complete** — admin console + full gateway (all three dialects,
any-to-any translation, tools/vision, fallbacks, client keys, logs/cost).
Post-MVP additions shipped: multi-adapter providers (session 10),
keyless-native default + `stream_options.include_usage` (session 11),
**M8 accounts + MoR billing (session 13)**, **M9 multi-user orgs/teams
(session 14)**, **M10 rate limiting (session 15)**, **M11 semantic cache
(session 17)**, **M12 native Gemini adapter (session 18)**, **M13 embeddings
(session 19)**, **M14 playground UI (session 20)**.
Current verification baseline lives in STATUS.md.

**The user's stated post-MVP order is exhausted (M8–M14 all shipped).** Next
work comes from the "Also queued" polish list below or user direction.

## Completed milestones (M1–M10)

- **M1+M2 — Foundation** — scaffold, admin auth (DB-backed revocable
  sessions), providers/models CRUD, AES-256-GCM-encrypted provider keys,
  test-connection, overview dashboard.
- **M3 — Gateway core** — canonical request model, routing with
  `provider/slug` pinning, openai adapter, `POST /v1/chat/completions` +
  `GET /v1/models`.
- **M4 — Anthropic dialect** — `POST /v1/messages`, anthropic adapter,
  cross-dialect translation (JSON + SSE, both ways).
- **M5 — Responses dialect** — `POST /v1/responses` (client dialect only),
  translated Responses objects/events.
- **M6 — Tools/vision + fallback chains** — tool-calling + vision
  translation across all dialects, fallback chains with retries.
- **M7 — Client keys + logs** — client API keys (sha-256 storage, one-time
  reveal, allowlists, spend caps), request logs with usage + cost snapshots,
  logs + API keys UI, SDK snippets.
- **M8 — Public foundations (2026-09-18)** — portal user accounts
  (email/password, PBKDF2-SHA-256, per-user revocable sessions), user-scoped
  keys (`api_keys.user_id`), prepaid balance ledger in micro-USD drawn down
  per request (429 `insufficient_quota` at ≤ 0), Lemon Squeezy hosted
  checkouts + signature-verified idempotent webhook credits, admin users +
  billing-config surfaces, `/app` portal UI (signup/login, balance + top-up +
  usage, keys), admin Settings + Users pages.
- **M9 — Multi-user orgs / teams (2026-09-18)** — orgs + memberships with
  owner/member roles, rotatable join-code invites (no email sender), shared
  org prepaid balances drawn by org-scoped keys (creator attribution kept in
  `user_id`), request_logs `user_id` + `org_id`, portal Teams page (members/
  keys/usage/billing views + owner-only LS org top-ups), global admin
  Organizations page (rename/disable/ledgered-adjust/delete), delete-user
  owner-succession. Done-when verified: two orgs coexist without seeing each
  other's keys/logs/balances (smoke_m9 74/74); users self-serve signup →
  create key → call gateway.
- **M10 — Rate limiting (2026-09-18)** — public-launch blocker cleared:
  per-key / per-IP (anonymous) / per-model request caps in fixed 1-minute
  windows counted by a SQLite-backed Durable Object (cross-isolate, free-plan
  compatible; D1-counter alternative rejected — one extra D1 write per
  request), 429 + `Retry-After` in the caller's dialect, fail-open on limiter
  errors, admin Settings card + per-key/per-model fields, abuse-limiting
  defaults (120 key / 60 IP rpm) ON by default. Done-when verified: limits
  enforced under concurrent bursts (smoke_m10 33/33); documented in README.
  Captcha + key-scoped spend alerts deferred (see MEMORY.md "M10 deferrals").

MVP recap: admin console — login (revocable DB-backed sessions), overview,
providers CRUD + test-connection, models CRUD, API keys (one-time reveal,
allowlists, spend caps), request logs (filters, clear); API keys AES-256-GCM
at rest. Gateway — `POST /v1/chat/completions` · `POST /v1/responses` ·
`POST /v1/messages` · `GET /v1/models(/:id)` — any client dialect × any
upstream adapter (openai-compatible, anthropic), JSON **and** SSE,
tool-calling + vision translation, `provider/slug` pinning, fallback chains
with retries, per-key spend caps + model allowlists, per-request logs with
usage + cost snapshots, dialect-correct error envelopes.

## The roadmap (post-MVP, in the user's stated order)

**payments/billing → multi-user orgs → rate limiting → semantic cache →
native Gemini adapter → embeddings → playground UI.** (All seven done —
M8–M14 shipped 2026-09-18/19.)

**Audience (amended 2026-09-17, user): Khateway is going PUBLIC** (was
internal) — M8+ is a platform build-out: user accounts come first (checkout
needs an identity), and billing runs through a **merchant-of-record provider —
Stripe is OUT (unavailable to Cambodia-based sellers)**. Shortlist: **Lemon
Squeezy (first pick — Cambodia explicitly in its bank-payout list, payouts in
USD via bank/Payoneer) / Paddle / Polar**; KHQR/Bakong merchant QR if selling
locally in Cambodia; stablecoin processors optional later (regulatory gray
zone in KH — decide deliberately). **Public-launch gate: M10 rate limiting
was the launch blocker — cleared 2026-09-18** (per-key/IP/model caps ON by
default; see the M10 row below).

| M | Scope | Done when |
|---|---|---|
| ~~**M8 — Public foundations: accounts + billing (MoR)**~~ ✅ 2026-09-18 | *Shipped as:* portal accounts (email/password; magic-link + email verification deferred — no email sender on Workers), Lemon Squeezy MoR checkouts + webhook, micro-USD balance ledger, gateway balance gate, admin users/billing surfaces, `/app` portal UI | New user: signup → top-up via hosted checkout → key works until balance exhausted; webhook credit is signature-verified + idempotent; tax/invoices owned by the MoR |
| ~~**M9 — Multi-user orgs / teams**~~ ✅ 2026-09-18 | *Shipped as:* `orgs` + `org_members` with owner/member roles (last-owner guard), rotatable join-code invites, shared org balances drawn by org-scoped keys (creator attribution in `user_id`), request_logs user_id + org_id, portal Teams page (members/keys/usage/billing), global admin Organizations page + delete-user owner-succession; personal M8 balance behavior untouched | Two orgs coexist without seeing each other's keys/logs; users self-serve signup → create key → call gateway |
| ~~**M10 — Rate limiting**~~ ✅ 2026-09-18 (was the public-launch blocker) | *Shipped as:* fixed 1-minute windows in a SQLite-backed Durable Object (`RATE_LIMITER` binding, free-plan compatible — D1 counter rejected: +1 write/request), per-key (deployment default 120 rpm or per-key override) / per-IP for anonymous (60 rpm) / optional global per-model caps, 429 + `Retry-After` in the caller's dialect, fail-open on limiter errors, Settings card + model/key fields, request_logs record 429s; captcha + key-scoped spend alerts deferred | Limits enforced under concurrent smoke (`npm run smoke:m10` 33/33); documented in README |
| ~~**M11 — Semantic cache**~~ ✅ 2026-09-19 | *Shipped as:* D1 `cache_entries` keyed by sha-256 of the canonical request + resolved model slug (dialect-independent — one entry serves all three client faces), raw upstream payload stored + replayed through the normal passthrough/translation path, opt-in per model (`models.cache_enabled`) or per key (`api_keys.cache_enabled`) behind the `cache_enabled` master switch (default off) with `cache_ttl_seconds` (default 3600), text-only eligibility gate (no stream/tools/tool history/vision/n>1), lazy TTL expiry + sweep, `POST /admin/cache/flush` + stats, hits log `cache_hit=1` + bill/debit like any response, `x-khateway-cache: HIT/MISS` headers, Logs badge + Overview/Settings savings stats | Repeat prompts hit cache under a counted mock upstream (smoke_m11 30/30, incl. cross-dialect hits + TTL expiry + flush); logs mark hits with usage + exact priced cost |
| ~~**M12 — Native Gemini adapter**~~ ✅ 2026-09-19 | *Shipped as:* third upstream adapter `gemini` — builds `POST {base}/v1beta/models/{model}:generateContent` / `:streamGenerateContent?alt=sse` with `x-goog-api-key` from the canonical form (system folding, tool calls/results bound by name, data-URL → `inlineData` / https → `fileData` multiparts, `reasoning_effort` → `generationConfig.thinkingConfig.thinkingBudget`), responses normalized onto openai shapes in `dialects/gemini.ts` and served through the existing openai→X translation paths (usageMetadata: thoughts fold into output tokens); assistant-first + n>1 rejected `untranslatable_request`; `x-khateway-attempts` retries cover it like any adapter | Gemini models route through all three client dialects natively (smoke_gateway M12 matrix: openai/anthropic/responses × JSON/SSE × tools/vision/thinking/errors — 159/159) |
| ~~**M13 — Embeddings**~~ ✅ 2026-09-19 | *Shipped as:* `POST /v1/embeddings` speaking the OpenAI Embeddings API (the only embeddings client face — Anthropic has none), routed to openai-compatible `/embeddings` (relayed, JSON usage watcher) or native Gemini `:embedContent`/`:batchEmbedContents` (normalized onto the openai shape; `usageMetadata.promptTokenCount` logs tokens; base64 encoding packed client-side), sharing the chat pipeline's auth/gates/fallbacks/logging/balance debit via an `enforceSpendCap` + `enforcePostRoutingGates` extraction (chat behavior byte-identical), `request_logs.dialect: 'embeddings'` with input-only cost from `pricing_input`, anthropic-only providers → 501, no semantic cache (chat-shaped eligibility gate — deliberate); Logs filter option | Embedding requests log tokens + cost like chat does (smoke_gateway 176/176 incl. exact $-cost at $2/1M and native-gemini usageMetadata rows); no migration needed |
| ~~**M14 — Playground UI**~~ ✅ 2026-09-19 | *Shipped as:* in-admin Playground page (nav after Models) — model picker over enabled models, temperature/max-tokens params, system prompt, streamed openai-chat render (SSE, `include_usage`), Stop/Clear, and a "Request log" card polling the rows of the session's key; backed by session-scoped client keys (`api_keys.playground_session` = sha256 of the admin session token, migration 0008): `POST /admin/playground/key` rotates + mints (raw key shown once), keys hidden from the API Keys list, deleted at logout, swept when the session row dies; gateway itself unchanged — a playground key is an ordinary enrolled key | Playground round-trips a streamed chat against any enabled model — verified by `npm run smoke:m14` (24 checks: mint/rotate/hidden/log-cost/rotation-401-under-enforcement/logout-revoke) + a live browser pass against a local mock model |

## Recommended ops prerequisite (small, before/alongside M8)

Real deploy — `npx wrangler d1 create khateway` → replace placeholder
`database_id` in `wrangler.jsonc`; `wrangler secret put ADMIN_PASSWORD` +
`ENCRYPTION_KEY`; `wrangler d1 migrations apply khateway --remote`;
`npm run deploy`; then smoke the deployed URL (health, admin login, one real
chat + streamed call with a client key). First external client afterwards:
point **termagent** at the gateway (propose-only — cross-project, per
workspace rules).

## Also queued (rough-edge polish, unscheduled)

M10 leftovers deferred as out-of-done-when scope: signup captcha (needs a
Turnstile-style service + account/keys — an external-dependency decision) and
key-scoped spend alerts (needs a notification channel; no email sender on
Workers). Also: upstream `Retry-After`/backoff inside the fallback loop;
spend-cap reservation accounting (soft-cap overshoot); content-aware admin
test-connection (z.ai "200 with auth-error body" blind spot); optional
auth-failure logging; anthropic `cache_control` passthrough; intra-message
order + `n>1`/assistant-first support; success-path `x-ratelimit-*` response
headers; login/signup buckets through the DO (cross-isolate) instead of
per-isolate memory.
