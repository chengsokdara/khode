# MEMORY.md — Khateway cross-session memory

Last updated: 2026-09-19 (session 19)

## Project origin (the user's ask)

The user wants a **web platform for AI model routing like OpenRouter**: CRUD
providers, each provider CRUDs models, ONE base URL speaking the big-3 dialects
(`/v1/chat/completions`, `/v1/responses`, `/v1/messages`), easy + professional
UI/UX. In plan mode the MVP was walked through together; user approved with:

- **Name: Khateway**; originally scaffolded in `racode/khateway/` (sibling of `termagent/`); **moved to `~/Apps/khateway/` as a standalone project on 2026-09-17** (out of the racode workspace).
- Audience: **internal** (me/team) — single admin, client API keys; no billing.
- Stack: **Cloudflare Workers** (Hono + D1) + React SPA admin.
- Gemini via Google's **OpenAI-compat** endpoint (native adapter later —
  **shipped in M12, session 18**; the compat endpoint remains available).
- **Tool-calling translation included in v1.**
- Docs convention mirrors termagent: AGENTS/RULES/STATUS/MEMORY in-project. Workspace-level `racode/` AGENTS/RULES applied while the project lived there; **standalone since 2026-09-17** — its own AGENTS.md is the sole source of truth now.

## What the assistant did (honest history)

- Session 20 (2026-09-19, user ask: "Let's go M14."): **M14 — playground UI**
  built + verified, the last milestone in the user's stated post-MVP order.
  Design decision the roadmap left to design time: **a real client key scoped
  to the admin session, not a proxy route** — the playground calls the actual
  /v1 gateway with an ordinary enrolled `khat-` key so auth/rate-limits/
  fallbacks/logging run for real (a `/admin/playground/chat` proxy would have
  bypassed every gate and produced fake log rows). Mechanism: new
  `api_keys.playground_session` column (migration `0008_m14_playground`, one
  ALTER) = sha256 of the admin session token; `POST /admin/playground/key`
  ROTATES (deletes the session's previous key — raw material is hash-only, so
  it can never be re-revealed) and sweeps playground keys whose session row is
  gone/expired via a leftJoin on `sessions`; logout deletes the session's key;
  the keys list hides playground keys (`isNull`). Web: `pages/Playground.tsx`
  (model picker over enabled models, temperature/max-tokens, system prompt,
  SSE streaming render with `stream_options.include_usage`, Stop via
  AbortController, Enter-to-send, log-row card polling `api_key_id`-filtered
  logs after each completion). **StrictMode catch**: the double-mount would
  mint twice and mint #2 would revoke mint #1's key (rotate semantics) —
  fixed with a shared inflight promise in `api.createPlaygroundKey()`.
  Gateway code untouched. **No new vitest files** (orchestration surface;
  lifecycle pinned end-to-end by smoke). Verified: check ×3, vitest 266/266,
  build, migrate 0008, all seven smokes (admin green, gateway 176, m8 43,
  m9 75, m10 33, m11 30, **m14 24/24**), live browser pass (streamed
  round-trip against a local mock model: user/assistant bubbles + exact-cost
  log row; the known IAB locator-click flakiness drove the send via
  page-side events; fixtures deleted + logs cleared). Live-provider
  verification not run (real kios provider untouched). Contract in decisions
  → "M14 playground contract".
- Session 19 (2026-09-19, user ask: "Let's go M13."): **M13 — embeddings**
  built + verified. Design decisions the roadmap left to design time:
  **openai embeddings is the only client face** (Anthropic has no embeddings
  API — no cross-dialect matrix to build; every error is openai-envelope and
  the existing auth middleware covers the path unchanged), **two upstream
  adapters only** (openai-compatible `/embeddings` relayed untouched with the
  existing JSON tee-watcher for usage; native gemini `:embedContent` /
  `:batchEmbedContents` normalized by `geminiEmbeddingsToOpenAi`), **shared
  gates extracted from chatPipeline** (`enforceSpendCap` +
  `enforcePostRoutingGates` + `makeWaitUntil` — pure moves, chat behavior
  byte-identical, all chat smokes re-green) so embeddings inherit client-key
  auth, spend caps, rate limits, allow-lists and personal/org balances with
  zero duplicated gate code. **No schema change**: request_logs.dialect is a
  plain text column — 'embeddings' joins the vocabulary by convention.
  **Gemini embeddings DO log tokens** (verified against
  ai.google.dev/api/embeddings: both endpoints return
  `usageMetadata.promptTokenCount`; body carries `model: "models/{id}"` +
  `content.parts[].text`, options under `embedContentConfig` — dimensions →
  outputDimensionality, `task_type`/`title` extras → taskType/title);
  `encoding_format: 'base64'` on a gemini upstream packs floats client-side
  (`floatsToBase64`, little-endian float32). **Semantic cache deliberately
  does NOT apply** (M11's eligibility gate is chat-shaped). Smoke-iteration
  catch: the pre-existing M7 "unknown model 404" log check began matching the
  new embeddings 404 row (both use `zzz-not-real`) — pinned it to
  dialect 'chat' so each check asserts its own row. Verified: check ×3,
  vitest **266/266** (+23), build, all six smokes (admin green, gateway
  **176**, m8 43, m9 75, m10 33, m11 30). Browser pass not run (UI delta =
  one Logs dropdown option). Live-provider verification NOT run (no real
  embeddings key; wire pinned by goldens + mock checks). Contract in
  decisions → "M13 embeddings contract".
- Session 18 (2026-09-19, user ask: "Let's go M12."): **M12 — native Gemini
  adapter** built + verified. Design decision the roadmap left to design
  time: **normalize gemini onto openai shapes, then reuse every existing
  translation cell** — there is no gemini client dialect, so
  `respondTranslated` rewrites a gemini Response/stream into openai chat
  shape (`dialects/gemini.ts`) and re-tags the meta as the openai upstream;
  the openai client face becomes passthrough of the normalized body and
  anthropic/responses clients ride their battle-tested translators. Writing
  three direct gemini→X translators (JSON+SSE each) was rejected as 3× the
  code for identical output. Other decisions: **tool results bind by NAME**
  (Gemini has no call ids — the adapter resolves the name from the assistant
  turn's calls, so synthesized `call_gemini_<n>` ids round-trip), **thoughts
  bill as output** (usageMetadata.candidatesTokenCount EXCLUDES thinking;
  total = prompt + thoughts + candidates — completion = candidates +
  thoughts), **assistant-first + n>1 rejected** like anthropic (explicit
  400/dual-adapter retry instead of betting on Gemini's leniency),
  **`joinAdapterUrl` inserts `/v1beta` on bare origins** (mirrors the openai
  rule; pasted paths never touched; the anthropic /v1-strip is NOT applied).
  `preferredAdapter`'s no-dialect-match fallback changed from "prefer openai"
  to "provider's first declared adapter" — behavior-identical for pure
  openai/anthropic providers, and it lets a `[gemini, openai]` provider serve
  anthropic/responses clients through the native adapter. Smoke-iteration
  catch (fixed pre-ship): the anthropic-face stream check substring-matched
  the assembled text — the session-5 lesson (parse events, never substring
  SSE) re-applied. Verified: check ×3, vitest **243/243**, build, all six
  smokes (admin green, gateway **159**, m8 **43**, m9 **75**, m10 **33**,
  m11 **30**), live browser pass (Providers modal: gemini checkbox + hint +
  quick-fill chip filling the /v1beta base). Live-provider verification NOT
  run (no real Gemini key; wire pinned by goldens + mock matrix). Contract in
  decisions → "M12 native Gemini adapter contract".
- Session 17 (2026-09-19, user ask: "Let's go M11."): **M11 — semantic
  cache** built + verified. Design decisions the roadmap left to design time:
  **D1 table over KV/DO** (KV is eventually consistent — a repeat prompt must
  deterministically HIT and smoke tests must not flake; DO would work but
  adds a binding + no SQL flush/stats), **canonical-request hash key** (the
  roadmap's "semantic cache" name kept its exact-match scope: sha-256 over a
  key-sorted stable JSON of the canonical request + model slug —
  dialect-independent so one entry serves all three client faces; true
  embedding-similarity search stays future work, naturally M13+ since
  embeddings don't exist yet), **store the RAW upstream payload + adapter
  kind** (hits replay through the exact same respondTranslated path — no
  parallel serve implementation, byte-identical passthrough). New
  `src/worker/cache/` (key.ts pure + store.ts D1), migration `0007_m11_cache`
  (generated cleanly, renamed + journal tag updated), settings snapshot
  extension, gateway wiring (lookup after ALL billing gates; store via
  Response.clone() + waitUntil with payload guards), admin/portal surfaces,
  Settings/Models/ApiKeys/Logs/Overview UI, 17 new vitest tests,
  smoke_m11.mjs (30 checks, call-counting mock upstream). Verified: check ×3,
  vitest **197/197**, build, migrate, all six smokes (admin green, gateway
  **138**, m8 **43**, m9 **75**, m10 **33**, m11 **30**), live browser pass.
  Smoke-iteration catches (fixed pre-ship): serveCachedResponse initially
  skipped draft.pricing → hit rows logged cost_usd null (the smoke's exact
  cost assertion caught it); cacheStats first shipped camelCase keys —
  breaking the snake_case DTO convention (hit by the stats assertion). IAB
  click flakiness persists (drive UI via page-side events, known). Contract
  in decisions → "M11 semantic cache contract".
- Session 15 (2026-09-18, user ask: "Let's go M10."): **M10 — gateway rate
  limiting** built + verified, clearing the public-launch blocker. Design
  decision the roadmap deferred to design time: **Durable Object over a D1
  counter** (a D1 upsert would add one D1 write per gateway request — doubling
  write load and burning the free-tier budget; the DO keeps counters in its
  co-located SQLite storage, `new_sqlite_classes` so the free plan works). New
  `src/worker/ratelimit/` (`do.ts` RateLimiterDO + `client.ts` builder +
  fail-open client), RATE_LIMITER binding + class migration in wrangler.jsonc,
  migration `0006_m10_rate_limits` (models.rate_limit_rpm,
  api_keys.rate_limit_rpm — plain ALTERs, generated cleanly), settings
  snapshot refactor (enforcement + rate-limit settings cached together),
  gateway 429 + Retry-After wiring, admin/portal surfaces, tests + smoke_m10
  (33 checks). Verified: check ×3, vitest **180/180**, build, migrate, all
  five smokes (admin, gateway **138**, m8 **43**, m9 **75**, m10 **33**),
  live browser pass over the three changed UI surfaces. Gotchas recorded: the
  in-app browser's locator clicks time out on this SPA (drive modals via
  page-side events / form.requestSubmit — NOT a product bug); existing smokes
  now PATCH `rate_limit_enabled: 'off'` at setup because default-ON limiting
  throttles their anonymous bursts. Captcha + key-scoped spend alerts
  deferred (decisions → "M10 deferrals"). Contract in decisions →
  "M10 rate limiting contract".
- Session 14 (2026-09-18, user ask: "Let's go M9."): **M9 — multi-user orgs /
  teams** built + verified. Migration `0005_m9_orgs` (orgs, org_members,
  api_keys.org_id, request_logs.user_id/org_id, balance_entries.org_id +
  nullable user_id — drizzle-kit generated cleanly this time; the
  data-preserving balance_entries recreate was inspected by hand, no spurious
  providers recreate because `providers.adapters` stayed declared LAST with
  its default). New `routes/orgs.ts`; gateway org gate + org debit; webhook
  org credit; admin /orgs + delete-user succession; portal Teams page; admin
  Organizations page; `scripts/smoke_m9.mjs` (74 checks). Verified: check ×3,
  vitest **165/165** (+2 LS org goldens), build, admin smoke, gateway smoke
  **137/137**, smoke:m8 **42/42**, smoke:m9 **74/74**, live browser pass.
  Lessons in decisions: per-USER join rate bucket (smoke reruns starved the
  shared IP bucket), emails are stored LOWERCASED (the smoke's `email('A')`
  uppercase handle silently broke every id lookup), and the admin
  EditOrgModal shipped with a conditional hook (useMutation after early
  return) that blanked the page — the browser pass caught it; hooks always
  before early returns. Contract in decisions → "M9 orgs/teams contract".
- Session 13 (2026-09-18, user ask: "let's go with the next milestone"):
  **M8 — public foundations: accounts + MoR billing** built + verified.
  Schema `0004_m8_accounts_billing` (users, user_sessions, balance_entries,
  webhook_events, api_keys.user_id — generated with drizzle-kit, then the
  spurious `providers` table-recreate hand-trimmed; see decisions for the
  column-order gotcha). PBKDF2 password hashing in crypto.ts; user sessions +
  portalAuth in auth.ts; `public_signup` setting; billing module
  (src/worker/billing/: config + lemonsqueezy); routes portal.ts (/app/api),
  webhooks.ts (/webhooks/lemonsqueezy); admin users/billing-config/settings
  additions; gateway prepaid-balance gate + usage debit in the log-writer's
  waitUntil path; /app portal SPA (login/signup, dashboard with balance +
  top-up presets + ledger + usage, keys with one-time reveal); admin Settings
  (gateway toggles + LS config + webhook URL display) and Users (list,
  balance adjust, enable/delete) pages. Verified: check x3 clean, vitest
  **163/163** (+14: password hashing x5, LS webhook parse/credit x9), build
  clean, admin smoke green, gateway smoke **137/137**, smoke:m8 **42/42**,
  plus a live browser pass (signup -> dashboard -> key create + reveal ->
  admin settings/users -> $2.50 adjustment reflected). Smoke-hardening
  lessons in decisions/rough edges: D1 constraint errors are wrapped by
  drizzle as "Failed query: ..." — never string-match "UNIQUE"; the in-memory
  login limiter is now bucketed (admin/portal-login/portal-signup) because
  all smoke suites share one local IP within the 60 s window.
- Session 1: plan made in Plan mode → user answered decision questions + approved → M1+M2 built in the same session. Verified with `scripts/smoke.mjs`.
- Session 2: **M3 gateway core** built + verified (see STATUS.md). Found on arrival: a leftover watch-mode `wrangler dev` from session 1 was still listening on :8787 — and it had hot-reloaded all M3 source changes (verified by probing the new `/v1/models` route), so it was used as the test server instead of killing anything.
- Session 3: **M4 anthropic dialect + cross-dialect translation** built + verified (40/40 gateway smoke). Same orphaned `wrangler dev` on :8787 hot-reloaded everything; used as the test server again. Refactored shared plumbing out of adapters/openai.ts into adapters/base.ts and deduped option validators into dialects/options.ts + SSE framing into dialects/sse.ts — minimal moves, behavior preserved (M3 smoke tests unchanged and green).
- Session 4: **M5 `/v1/responses`** built + verified (61/61 gateway smoke; +21 M5 checks). Same orphaned watch-mode `wrangler dev` hot-reloaded everything again. No new upstream adapter by design (see decisions); live round-trip vs the user's real provider verified for non-stream AND streamed responses (canonical Responses event sequence observed on the wire).
- Session 5: **M6 tools/vision + fallback chains** built + verified (91/91 gateway smoke; +30 M6 checks after replacing the M6-pointer checks). Same orphaned `wrangler dev` hot-reloaded everything again. One real bug caught by smoke before it could ship: `makeResponsesStream.close()` flipped `closed` before calling `finalizeMessage()`, whose guard checks `closed` — the Responses `.done` events never emitted; ordering fixed. Two initial smoke assertions substring-matched JSON-escaped SSE fragments and were rewritten to parse events (`parseSseEvents`/`parseDataLines` helpers). Live tool probes vs `glm-5.3-flash` all hit the upstream's own per-user concurrency limit — relay proven correct on the error path only (same provider quirk as session 4).
- Session 6: **M7 client API keys + request logs** built + verified (112/112 gateway smoke; +21 M7 checks; admin smoke extended). Same orphaned `wrangler dev` hot-reloaded everything again. Live end-to-end vs the user's **z.ai coding plan**: first probes failed with upstream `model_access_denied` at the user-supplied base `https://api.z.ai/api/v1` — diagnosis: coding-plan keys only have model permissions on the coding endpoint `https://api.z.ai/api/coding/paas/v4` (z.ai authenticates the key on /api/v1 but denies every model; /models returns HTTP 200 with an auth-error body, which fooled admin test-connection into ok:true). After re-pointing the provider base_url, live `/v1/responses` non-stream AND stream worked end-to-end (translated Responses objects/events, real usage). The user's model slug `glm-5.3-flash` was re-pointed from KiosAPI to the new Z.ai provider (one PATCH; KiosAPI left in place, unused). Smoke caught two real bugs pre-ship: same-dialect JSON passthrough never captured usage (the tee watcher assumed SSE framing — made content-aware) and unknown-pricing cost rendered as $0 instead of null (null pricing ≠ free; fixed `costUsd` semantics).
- Session 7: **golden-fixture vitest suite** built (125/125) — the session-6 "next steps" #1. User picked it from a menu (deploy / fixtures / fallback polish / aliases). New `tests/fixtures/*.json` + `tests/worker/*.test.ts` runners; vitest + @types/node added as devDeps (explicitly user-approved via the chosen option); `npm test`; `check` now covers `tsconfig.test.json`. 9 first-run mismatches: 8 were my fixture-derivation slips (see lessons below), 1 was a **real dead-code bug**: `anthropicMessages.errorTypeForStatus` tested `status >= 500 → 'api_error'` before its TYPE_BY_STATUS table, so `504 → timeout_error` and `529 → overloaded_error` were unreachable — fixed by table-first lookup (gateway smoke re-green; nothing asserted those types). All worker modules run under plain Node ≥20 (crypto.subtle/streams/Response globals) — no miniflare/workers-pool needed for the wire-format suites. Routing/DB/gateway orchestration stay covered by the two smoke scripts (they need D1 + HTTP).
- Session 9 (2026-09-17, rebrand + move): user asked to rebrand **Rauter →
  Khateway** and move the project out of the racode workspace to
  **`~/Apps/khateway/`** (standalone). Global rename (`Rauter`→`Khateway`,
  `rauter`→`khateway`, key prefix `raut-`→`khat-`) across worker, web, scripts,
  tests, fixtures and docs + package-lock name fields; manual follow-ups for
  location references (`racode/…` → `~/Apps/khateway/`) and the `.dev.vars` dev
  password kept in sync with the smoke scripts. Pre-existing client keys keep
  working (hash lookup, no prefix check). Verified `check` ×3 + 125/125 vitest
  before and after the move; racode workspace docs updated to drop the project.
  Local D1 then refreshed (user OK'd the wipe): `.wrangler/state` removed, both
  migrations re-applied, pre-rename `web-dist/` rebuilt — closing both rename
  caveats (no legacy `raut-` keys anywhere, no old-brand data). Smokes re-run
  end-to-end on the fresh DB: admin smoke green, gateway smoke **112/112**;
  post-smoke tables verified empty.
- Session 12 (2026-09-17, docs): **ROADMAP.md created** — the "Upcoming
  milestones" roadmap + the M1–M7 MVP recap moved out of STATUS.md into the
  dedicated roadmap file (completed milestones, post-MVP order + MoR context,
  M8–M14 table, deploy prerequisite, polish queue). STATUS.md now keeps live
  state only and points to ROADMAP.md; AGENTS.md doc map updated. No code
  change.
- Session 11 (2026-09-17, keyless-native default): khode went keyless — user
  asked for anonymous-by-default /v1 with optional enforcement. Shipped the
  `settings` table + `client_key_enforcement` flag, anonymous sentinel, TTL
  cache, admin endpoints + UI toggle, include_usage plumbing. Live e2e vs
  `wrangler dev` + mock upstream: all keyless/enforcement matrix checks green
  (gateway smoke 137/137), curl acceptance replicated live (no-auth SSE 200,
  Bearer anonymous 200, models 200, invalid khat- 401 only when enforcement
  on). A smoke iteration caught the expectation flip: in default mode a
  DISABLED enrolled key no longer 401s (it rides anonymously) — enforcement
  mode still pins the strict behavior.
- Session 10 (2026-09-17, multi-adapter providers): user asked for ONE provider
  row for vendors compatible with both adapters (and future-proof for more
  adapters — rejected a fixed `both` enum value on those grounds). Shipped
  `providers.adapters` JSON array (house pattern: capabilities/fallbacks also
  arrays). Verified: check ×3, vitest 127/127, admin smoke green, gateway
  smoke 117/117 (+5 dual-provider checks). drizzle-kit `generate` cannot do
  column renames non-interactively (needs TTY) — migration 0002 was
  hand-written (ADD adapters DEFAULT '["openai"]' + backfill + DROP adapter)
  with the meta snapshot/journal edited by hand.
- Session 8 (2026-09-17, docs/verification): user declared MVP done (M1–M7) and asked for a STATUS.md rewrite. Re-ran the full baseline against the (orphaned, hot-reloaded) dev server on :8787: `check` ×3 clean, vitest 125/125, build clean, admin smoke green, gateway smoke **112/112** (61 → 112 grew with M7; AGENTS count updated). STATUS.md rewritten for MVP completion (every feature row ✅ with its verification source); README milestones marked ✅; deduped a repeated MEMORY bullet. Cautions recorded: `smoke:gateway` wipes local `request_logs` (its `DELETE /admin/logs` step) — the only user data it touches; AGENTS.md file map was already current from sessions 2–7 (no rewrite needed).
- Mid-session (session 1, all fixed, kept for honesty): ECONNRESET during writes left a partial `routes/admin.ts` (recovered by full clean rewrite); one hasty `auth.ts` draft contained placeholder junk (caught immediately, rewritten clean); vite `outDir` was initially `../../../web-dist` which spilled build output to the workspace root (cleaned up + fixed to `../../web-dist`).
- Mid-session (session 2, all fixed, kept for honesty): adapters/openai.ts was first written half-drafted (caught immediately, rewritten complete); smoke script read a streamed SSE body through a helper that had already consumed it via `.json()` (fixed with a raw fetch for the stream test); discovered mounted Hono sub-apps bypass their own `notFound()` — the root app's notFound won and returned admin-shaped errors on unknown `/v1/*` paths; fixed with a wildcard `all('*')` route inside the gateway.
- Smoke testing found a real security hole (session 1): **session tokens were stateless, so "logout" didn't revoke** — fixed by DB-backed revocable sessions (`sessions` table keyed on sha256(token)); smoke now proves logout → 401.
- Live verification quirk: user's real provider (KiosAPI, model `glm-5.3-flash`) was reachable through the full pipeline but only its error path was observable at test time — the upstream itself returned its own 60 req/min shared rate limit; Khateway relayed it correctly in OpenAI envelope form.

## Decisions already made (do not re-litigate without asking)

- **M18 structured-outputs contract (session 22, do not regress)**:
  - **Canonical**: `responseFormat {type:'json_object'|'json_schema', name?,
    schema?, strict?}`; validated by `responseFormatOption(v, param, shape)`
    (shape 'openai-chat' reads the nested `json_schema` object; 'responses'
    reads the flat shape + accepts `{type:'text'}` as none). Unknown types →
    explicit 400.
  - **Adapter stances**: openai re-emits verbatim (nested form). Gemini:
    `responseMimeType:'application/json'` + `responseSchema` through the
    recursive cleaner (keeps type/format/description/nullable/enum/maxItems/
    minItems/properties/required/items/propertyOrdering; lowercases type;
    drops $schema/additionalProperties/etc.) — json_object sends the MIME
    type only. Anthropic: BEST-EFFORT system directive ("Respond with ONLY a
    JSON object…"; json_schema embeds the schema) — documented as not a hard
    guarantee; the upgrade path is single-tool emulation (forced tool_choice
    + response-side unwrapping), a deliberate cut this session.
  - **Cache**: reasoning + responseFormat ride cacheKeyInput ONLY when
    present (spread) — never add unconditional fields to the projection; it
    would invalidate every stored entry.
  - response_format is parsed OUT of openai-chat extras (canonical home);
    unknown top-level params still ride extras as before.

- **M17 reasoning/thinking contract (session 22, do not regress)**:
  - **reasoning_content is the openai-face convention** (DeepSeek/GLM — the
    same field this gateway accepts in history and emits on both JSON and
    SSE). Anthropic thinking blocks/`thinking_delta` and gemini thought
    parts both normalize onto it; the reverse translators emit anthropic
    thinking blocks (leading the message, signature verbatim) and responses
    `rs_*` reasoning items with `summary_text`.
  - **Budget precedence**: explicit `budgetTokens` > `effort` bucket
    (EFFORT_BUDGETS in dialects/options.ts: minimal 0 / low 1024 / medium
    8192 / high 24576). Anthropic: clamped to max_tokens-1, DROPPED when the
    clamp falls below the API's 1024 floor (request succeeds WITHOUT
    thinking; do not "fix" to a hard error); temperature/top_p suppressed
    while thinking is on (API forbids them). Gemini: 0–32768 clamp,
    `includeThoughts: true` whenever budget > 0. Openai: only `reasoning_effort`
    re-emits (budgets are gateway-only); minimal → NOT re-emitted to openai
    (not in its vocabulary).
  - **History reasoning**: anthropic keeps it (thinking blocks lead the
    turn — signature rides verbatim); openai and gemini histories DROP
    reasoning (`reasoning_content` never reaches gemini/openai upstreams —
    not needed to continue a conversation). Responses reasoning input items
    fold summary_text into canonical reasoning.
  - **Redacted thinking**: parses (`data` → canonical redacted), re-emits to
    anthropic only, is dropped by every translator (no client-visible text).
  - **Responses reasoning items**: lazy-opened BEFORE the message item,
    finalized (summary_text.done → part.done → output_item.done) before it;
    a reasoning-only stream is valid output; sequence numbers stay monotonic.
  - **Billing unchanged**: anthropic counts thinking in output_tokens; gemini
    thoughts fold into output (M12). Cache keys: canonical reasoning rides
    cacheKeyInput via the request projection — a thinking and a non-thinking
    variant of the same prompt are DIFFERENT entries (correct).

- **M16 parity-pack contract (session 21, do not regress)**:
  - **/v1/models pricing is per-token decimal strings** derived from
    USD-per-1M via `usdPerMillionToPerToken` (toFixed(12) + trailing-zero
    trim — exponent notation like 1.5e-7 breaks client parsers). Both sides
    null → `pricing: null` (unknown ≠ free); one side unset → that member
    null. `supported_parameters` = union over the provider's declared
    adapters of `ADAPTER_SUPPORTED_PARAMS` (gateway.ts) — extend per adapter
    when new canonical options land (M17 adds nothing there; M18 will).
  - **/api/v1 requires a real key even under the keyless default** (the
    answers describe that key). `/auth/key` + `/key` aliases, `/credits`
    scopes to user OR org by the key; admin-managed keys (no user/org) →
    404 `no_balance`. In-memory `client-api` bucket 60/min/IP — move it
    through the DO together with the login buckets when that polish lands.
  - **/v1/completions never passes through raw** — even openai→openai is
    rewritten chat→text_completion (that's the face's whole point). The
    route feeds `chatPipeline` a `preParsed` canonical request
    (dialect 'openai'); errors keep the openai envelope; log rows carry
    `dialect='completions'`. Prompt arrays and echo/suffix/best_of/logprobs/
    logit_bias → explicit 400. Stream rewriter: comments consumed,
    usage-only chunk preserved, `[DONE]` synthesized ONLY when the upstream
    never sent one (never double).
  - **x-ratelimit success headers** (`x-ratelimit-limit/remaining/reset-
    requests`) render from the BINDING bucket (max count/limit — same pick
    as the 429 message) whenever limiting ran; no headers when disabled or
    limiter fail-open. No DO protocol change was needed — decisions already
    carried count/limit/resetAfterMs.
  - **Keep-alives**: `withSseKeepAlive` (sse.ts) wraps every TRANSLATED SSE
    response, the passthrough SSE client branch, and the completions output;
    the usage-watch tee branches stay raw. `usage: {include:true}` maps onto
    canonical `streamIncludeUsage` and is stripped from extras.
  - **Attribution**: request_logs.http_referer (≤300 chars) + x_title
    (≤120 chars), read from `HTTP-Referer`/`X-Title` on /v1; cache keys do
    NOT include attribution (same prompt from two apps shares one entry).

- **M15 hardening + deploy contract (session 21, do not regress)**:
  - **Webhook record+credit is ATOMIC**: `webhook_events` INSERT rides the
    same D1 batch as the ledger insert + balance bump. Never split the
    delivery-record from the credit again — a recorded-but-uncredited delivery
    makes every LS retry answer "duplicate" and the top-up is silently lost.
    Only `isUniqueViolation(err, table)` (walks the drizzle cause chain for
    `UNIQUE constraint failed: <table>.` — trailing dot for exact table
    match) may answer `{ok, duplicate:true}`; ANY other error must throw (500)
    so Lemon Squeezy retries into a clean state. Non-crediting outcomes still
    answer 200 with a recorded note (no LS retry-loops).
  - **request_logs carries `request_logs_api_key_idx`** (migration 0009): the
    spend-cap SUM + logs filters + keyUsage aggregates all hit api_key_id on
    every keyed request. Portal keyUsage is SQL SUM+count — never a row load.
  - **Admin PATCH validation order**: validate `balance_adjust_usd` before
    applying the `enabled` toggle (no partial application on 400).
  - **Root onError is generic**: `Internal server error` 500; raw err.message
    (SQL fragments) never reaches clients; `HTTPException` from
    `hono/http-exception` passes through with its own status/message.
  - **Remote deploy facts (2026-09-19)**: remote D1 `khateway` =
    `32583a0a-d5ed-4e14-8308-0e0c019f2fcc` (in wrangler.jsonc — placeholder
    gone); Worker live at **https://khateway.chengsokdara.workers.dev**
    (account cf8467c085e4ec1d0735b3136f4884ad, chengsokdara@gmail.com);
    secrets ENCRYPTION_KEY (fresh random) + ADMIN_PASSWORD (= the .dev.vars
    value) set via piped stdin — never printed to chat/logs. Rotate the admin
    password with `npx wrangler secret put ADMIN_PASSWORD` whenever asked.
    Deployed-surface smoke: /health, keyless /v1/models, bogus-model 404
    envelope, admin login 200, SPA 200. The remote DB starts EMPTY — real
    providers/models must be registered in the admin console (or migrated by
    hand); smokes must NEVER run against it (they wipe logs/fixtures).
  - **git**: the repo is on `main` (init session 21 — the project was
    UNVERSIONED before that). .gitignore covers node_modules/.wrangler/
    web-dist/.dev.vars/.video_agent/.zcode. Commit at milestone boundaries.

- **M14 playground contract (session 20, do not regress)**:
  - **Session-scoped keys, not a proxy**: the playground hits the REAL /v1
    gateway with an ordinary enrolled key so every gate (auth, spend cap,
    rate limits, allow-list, balance) and the real request_logs row apply.
    Never replace this with an admin-authenticated proxy route.
  - **`api_keys.playground_session`** = sha256 of the admin session token;
    null = a normal key. Playground keys have name 'Playground', no spend
    cap, no allow-list, default rate limit — they are ephemeral conveniences,
    not credentials to manage.
  - **Mint = rotate**: `POST /admin/playground/key` (adminAuth) deletes the
    session's previous key (raw material is hash-only — it can never be
    re-revealed), sweeps playground keys whose session row is missing or
    expired (leftJoin `sessions`), then mints fresh; the raw key rides only
    in the mint response. `POST /admin/logout` deletes the session's key;
    `GET /admin/api-keys` excludes playground keys.
  - **StrictMode-safe client**: `api.createPlaygroundKey()` shares one
    inflight promise across the double-mount — both mounts must use the SAME
    key (a second mint revokes the first's). Do not remove the dedupe.
  - **Streaming render**: openai chat dialect only, `stream: true` +
    `stream_options.include_usage` so streamed usage lands in logs; Stop =
    AbortController (partial text kept); after each completion the page polls
    `GET /admin/logs?api_key_id=<key>` for up to ~5 s (log rows land in
    waitUntil AFTER the stream ends) and renders the resulting rows.
- **M13 embeddings contract (session 19, do not regress)**:
  - **Client face**: `POST /v1/embeddings` speaks the OpenAI Embeddings API
    ONLY — Anthropic has no embeddings endpoint, so there is no translation
    matrix and every error (incl. 401 from the auth middleware, which maps
    any non-`/messages` path to the openai envelope) is openai-shaped.
    request_logs.dialect = `'embeddings'` (plain text column — no migration).
  - **Canonical form** (`CanonicalEmbeddingsRequest` in canonical.ts):
    `input: string[]` (a lone string normalizes to a 1-element array),
    `dimensions?`, `encodingFormat?: 'float'|'base64'`, `extras` (unknown
    fields pass verbatim to openai upstreams). Pre-tokenized integer input
    arrays are rejected 400 explicitly (gemini cannot express them).
  - **openai upstream** (`buildOpenAiEmbeddingsRequest`): POST
    `{base}/embeddings` (joinAdapterUrl's openai rules apply — `/v1` insert
    on bare origins), body `{...extras, model, input, dimensions?,
    encoding_format?}`. The response is RELAYED untouched (chat-style
    passthrough); usage comes from the JSON tee-watcher
    (`usage.prompt_tokens` → tokensIn; `completion_tokens` absent →
    tokensOut null). tokensOut stays null for embeddings — there are no
    output tokens; cost = tokensIn × `pricing_input` ONLY.
  - **gemini upstream** (`buildGeminiEmbeddingsRequest`): 1 input →
    `POST {base}/models/{m}:embedContent`, >1 → `:batchEmbedContents` with
    one `{model: "models/{m}", content:{parts:[{text}]}}` entry per input
    (Google preserves order). Options under `embedContentConfig`:
    `dimensions` → `outputDimensionality`, extras `task_type`/`title` →
    `taskType`/`title`; all other extras dropped (same stance as chat).
    Wire facts verified 2026-09-19 against ai.google.dev/api/embeddings —
    both endpoints return `usageMetadata.promptTokenCount`, so gemini
    embeddings log real tokens (usageFromJsonBody('gemini', …) already maps
    promptTokenCount → tokensIn). Response normalization
    (`geminiEmbeddingsToOpenAi`) emits the openai list shape
    `{object:'list', data:[{object:'embedding', index, embedding}], model,
    usage?}`; `encoding_format:'base64'` packs float values client-side via
    `floatsToBase64` (little-endian float32 → btoa) — gemini only returns
    arrays.
  - **Gates/chain**: embeddings reuses `enforceSpendCap` +
    `enforcePostRoutingGates` (extracted from chatPipeline in M13 — the chat
    pipeline calls the same helpers; behavior byte-identical) and the same
    chain-walk semantics: 429/5xx/timeout/network → next
    candidate/adapter; client 4xx surface immediately; `x-khateway-attempts`
    spans adapter + fallback tries. Adapter order: openai FIRST (matches the
    client face = passthrough), then gemini; a provider declaring only
    `anthropic` answers **501 `upstream_dialect_unsupported`** (no
    embeddings endpoint exists — logged with dialect 'embeddings').
  - **NO semantic cache for embeddings** — M11's evaluateCacheEligibility is
    chat-shaped; caching embeddings would need a new key projection. Deliberate scope cut; widen the gate deliberately if ever wanted.
  - **Model setup**: embedding models are ordinary model rows — set
    `pricing_input` (e.g. $0.02/1M); `pricing_output` is unused (null
    pricing still means null cost / no debit). Admin gemini discovery still
    SKIPS embedding models (M12 contract: non-generateContent entries never
    import) — add native-gemini embedding models by hand (openai-adapter
    providers import them from `/models` as usual; the Gemini OpenAI-compat
    `/v1beta/openai` base also serves embeddings).
  - **smoke note**: smoke_gateway's M13 block runs BEFORE the M7 log
    assertions and uses `zzz-not-real` for its own 404 check — the M7 check
    is pinned to `dialect === 'chat'` so the two never cross-match.

- **M12 native Gemini adapter contract (session 18, do not regress)**:
  - **Adapter registry**: `Adapter = 'openai' | 'anthropic' | 'gemini'` in
    `src/shared/adapters.ts` (KNOWN_ADAPTERS order = preference). NO schema
    change — `providers.adapters` JSON array already admits 'gemini'; admin
    `normalizeAdapters` validates against KNOWN_ADAPTERS automatically.
  - **URL rule (joinAdapterUrl)**: gemini paths are
    `/models/{model}:generateContent` / `:streamGenerateContent?alt=sse`
    (the endpoint encodes streaming — the body has NO `stream`/`model`
    fields; the model rides the URL path). `DEFAULT_BASES.gemini =
    https://generativelanguage.googleapis.com/v1beta`. A BARE ORIGIN gains
    `/v1beta` (mirrors the openai insert rule); any pasted path is kept
    verbatim; the anthropic trailing-`/v1` strip does NOT apply to gemini.
    Auth header: `x-goog-api-key` (never `?key=`).
  - **Request translation (adapters/gemini.ts)**: system/developer fold into
    `systemInstruction:{parts:[{text}]}` (joined '\n\n'); user→'user',
    assistant→'model'; consecutive same-role turns MERGED (functionResponse
    parts lead user turns, mirroring anthropic's tool_result-first rule);
    tool calls → `functionCall:{name, args:<object>}`; tool results →
    `functionResponse:{name, response:<object>}` where `name` is resolved
    from the assistant turn's toolCalls map (Gemini binds by NAME — it has
    no call ids) and `response` is the parsed JSON object when the content
    is one, else `{result: content}` (content rides INSIDE the response —
    never duplicated as a text part); images → `inlineData:{mimeType,data}`
    for data URLs / `fileData:{mimeType:'image/png', fileUri}` for https;
    options → `generationConfig` (temperature/topP/maxOutputTokens from
    EITHER token field/stopSequences/topK from the `top_k` extra).
  - **Thinking budgets**: openai-face `reasoning_effort` extra →
    `generationConfig.thinkingConfig.thinkingBudget` (minimal→0 = disabled
    [Flash tier only; Pro 400s upstream honestly], low→1024, medium→8192,
    high→24576); defensive `thinking.budget_tokens` extra clamped 0–32768.
    `includeThoughts` is NOT requested; `thought:true` parts are skipped in
    responses. The anthropic parser still rejects `thinking` (unchanged).
  - **Response normalization (dialects/gemini.ts)**: gemini JSON/SSE → openai
    chat completion/chunk shapes, then the EXISTING openai-upstream paths
    serve every client face (openai client = passthrough of the normalized
    body; anthropic/responses = existing translators). details pinned by
    goldens: functionCall → tool_calls `call_gemini_<n>` (index-sequential)
    with full-arguments JSON-string deltas; finish_reason 'tool_calls' when
    any call is present (Gemini only ever says STOP) but MAX_TOKENS still
    wins ('length'); SAFETY/RECITATION/BLOCKLIST/PROHIBITED_CONTENT/SPII/
    IMAGE_SAFETY → 'content_filter'; `promptFeedback.blockReason` (no
    candidates) → role chunk + content_filter finish; synthesized streams
    ALWAYS close with a finish chunk + usage + [DONE] (downstream translators
    depend on that). Synthesized id = `chatcmpl-<responseId>` (all chunks —
    responseId is read before the first emit).
  - **Usage/billing**: `usageMetadata.promptTokenCount` → in;
    `candidatesTokenCount + thoughtsTokenCount` → out (Google: total =
    prompt + thoughts + candidates, so thinking bills as output). The log
    row for gemini JSON paths reads the RAW payload (`usageFromJsonBody
    ('gemini', …)`); streamed paths watch the SYNTHESIZED openai stream
    ('openai' watcher) — usage rides the synthesized finish/usage-only
    chunk, so a non-Gemini proxy that omits usageMetadata logs 0/0 instead
    of null (accepted; real Gemini always sends it). Cache entries store the
    RAW gemini payload with upstream='gemini' and replay through the same
    normalization (`serveCachedResponse` maps the entry.upstream).
  - **Errors**: `geminiErrorToOpenAi` parses Google's
    `{error:{code,message,status}}` — status string → openai type
    (RESOURCE_EXHAUSTED→rate_limit_error, UNAUTHENTICATED→authentication_
    error, PERMISSION_DENIED→permission_error, NOT_FOUND→not_found_error,
    DEADLINE_EXCEEDED→timeout_error, …), unknown statuses derive from HTTP
    status, the gemini status string rides in `code`. Anthropic clients get
    the normalized body re-rendered via `upstreamErrorToAnthropic` (gateway
    `upstreamErrorBody` helper used for BOTH the immediate-4xx and the
    chain-exhausted paths).
  - **Adapter selection**: `preferredAdapter` = client-dialect match
    (openai/responses→openai, anthropic→anthropic), else the provider's
    FIRST DECLARED adapter (changed from "prefer openai" — no behavior
    change for pure openai/anthropic providers; `[gemini, openai]` providers
    serve anthropic/responses clients natively). Assistant-first + n>1
    throw UnsupportedTranslationError → same-candidate other-adapter retry /
    400 `untranslatable_request` on gemini-only providers.
  - **Admin surfaces**: test-connection probes GET `/v1beta/models` with
    `x-goog-api-key` (model_count from `models[]`); fetch-models strips the
    `models/` prefix, maps inputTokenLimit/outputTokenLimit → context/out,
    SKIPS entries whose supportedGenerationMethods lack 'generateContent'
    (embedding/tts models never import). Vendor presets: `Gemini (native)`
    (base …/v1beta, adapters ['gemini']) alongside `Gemini (OpenAI-compat)`.
  - **Gemini wire facts (verified 2026-09-19 against ai.google.dev, do not
    "fix" without checking)**: generateContent under `/v1beta/models/…` —
    the newer "Interactions API" docs pages are drifting; the generateContent
    reference confirms `usageMetadata{promptTokenCount, candidatesTokenCount,
    thoughtsTokenCount, totalTokenCount}` with total = prompt + thoughts +
    candidates; REST accepts camelCase parts (`inlineData`, `functionCall`,
    `functionResponse`) — Google SDK JSON is camelCase. functionResponse.
    response must be a JSON OBJECT.

- **M10 rate limiting contract (session 15, do not regress)**:
  - **DO, not D1**: `RATE_LIMITER` binding → singleton `RateLimiterDO`
    ("global"), SQLite-backed class (`new_sqlite_classes` in wrangler.jsonc
    migrations — keeps the free plan supported; KV-backed DOs need paid).
    Fixed 1-minute windows in table `counters(scope, window_start, count)`;
    the increment is one atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING`
    and the DO is single-threaded, so concurrent bursts count exactly. In-memory
    counters were rejected: DOs evict when idle, which would silently reset
    limits under quiet traffic.
  - **Plain ES class + `POST /check` fetch protocol** — no
    `cloudflare:workers` import, so tsc (workers-types only) and vitest stay
    clean; the class is unit-tested offline by driving the real `fetch`
    handler against a fake SqlStorage.
  - **Fail-open everywhere**: `checkRateLimits` answers null on ANY limiter
    error → the request is served (same stance as the settings fail-open);
    malformed checks inside the DO answer allowed. A rate limiter must never
    be the thing that takes the gateway down.
  - **Bucket selection** (`buildGatewayRateChecks`, goldens pinned): keyed
    request → `key:<id>` only (`api_keys.rate_limit_rpm` override, else the
    deployment default); anonymous → `ip:<cf-connecting-ip>` (keyed requests
    NEVER share the IP bucket — NAT'd offices must not punish heavy keys);
    model with `models.rate_limit_rpm` → global `model:<slug>` on top.
    `rate_limit_enabled: 'off'` → zero checks, zero DO round-trips.
  - **Defaults are the launch posture**: enabled 'on', key 120 rpm, IP 60 rpm
    (absent settings rows = defaults; read ERROR = fail-open off until the
    5 s cache expires). API/settings validation bounds rpm to 1–100000.
  - **429 shape**: dialect envelope (`rate_limit_exceeded` /
    `rate_limit_error`) + integer `Retry-After` = max resetAfter across
    denied buckets; the message names the BINDING constraint (max
    count/limit), not just the first denial. 429s write request_logs rows
    (status 429, error text) like every other pipeline outcome.
  - **Existing smokes disable limiting at setup** (`rate_limit_enabled: off`)
    — they burst far past the IP default from one dev address. smoke_m10
    leaves 'off' at cleanup as the neutral dev state. NOTE: m10's anonymous
    IP bucket persists across re-runs within a window (keyed by address) —
    its "allowed ≤ limit" assertions tolerate that; keyed phases use fresh
    keys each run and are deterministic.

- **M11 semantic cache contract (session 17, do not regress)**:
  - **Opt-in model**: master setting `cache_enabled` ('on'|'off', default
    off — absent row = off) AND (model.cache_enabled OR key.cache_enabled).
    Anonymous requests can only be cached via the model flag. Portal/org key
    DTOs expose cache_enabled READ-ONLY (admins/models govern caching, same
    stance as rate_limit_rpm).
  - **Key**: sha256(stableStringify({v:1, model: resolvedSlug, messages
    (role/content/images/toolCalls/toolCallId/extra), options (all 9 canonical
    fields with ?? null), extras})) — hex. `stream` + `streamIncludeUsage`
    excluded. stableStringify sorts object keys recursively (property order
    never changes the key). `v:1` invalidates everything on a canonical
    change (old keys age out via TTL). Pinned (`provider/slug`) and unpinned
    requests share the entry (keyed by the resolved slug, not the raw field).
  - **Entry**: raw upstream JSON body + upstream ('openai'|'anthropic') +
    provider_id/provider_name/upstream_model snapshots + size + created_at +
    expires_at (= now + ttl AT STORE TIME; changing TTL later does not
    retroactively move expiries). Lookup = one SELECT key=? AND expires_at>
    now, fail-open (error = miss). Store = waitUntil: read the cloned body,
    skip ≥512 KB / non-JSON / 200-with-error-body payloads, then one D1 batch
    [sweep expired, INSERT onConflictDoNothing] (insert-after-sweep so an
    expired same-key row can't block the fresh entry).
  - **Serve**: hit → respondTranslated(payload-Response, meta with
    upstream=entry.upstream, attempts=1, cacheState='hit', candidate
    display-overridden with entry.providerName/upstreamModel) — same-dialect
    hits are passthrough (byte-identical), cross-dialect hits translate.
    draft.usageWatch nulled after (usage is final from the payload).
    draft.pricing follows the REQUESTED model's pricing (a fallback-produced
    entry debits primary pricing — deliberate, documented). Corrupt payload →
    null → normal upstream path.
  - **Order in the pipeline**: parse → spend cap → routing → rate limits →
    allow-list → balance gate → CACHE → chain walk. Hits consume rate-limit
    budget (checks ran first), log cache_hit=1 + usage + cost, and debit like
    any response. x-khateway-cache: HIT|MISS only on cache-eligible requests
    (others see no header).
  - **Eligibility** (evaluateCacheEligibility, goldens): not_opted_in,
    streaming, tools, tool_history (role 'tool' or assistant toolCalls),
    images, n_gt_1. Widen = additive change to that gate only.
  - **Admin**: GET /admin/cache → {entries, bytes, hits_24h,
    tokens_cached_24h} (SNAKE_CASE — the DTO convention burned me once here);
    POST /admin/cache/flush → {ok, flushed}. settings PATCH validates
    cache_ttl_seconds 1–2592000. Overview usage_24h gained `cached` count.
  - **smoke_m11 arithmetic**: upstream-call counts are cumulative across
    phases — recount when inserting phases. Settings toggles need the 5 s
    snapshot wait before dependent requests (same as smoke_m10).

- **M10 deferrals (deliberate, out of done-when scope)**: signup captcha
  (needs an external service — Turnstile-style — plus account/site keys: an
  external-dependency decision the user must make) and key-scoped spend
  alerts (needs a notification channel; no email sender on Workers). Signup
  rate limiting already exists (M8 per-isolate buckets); moving login/signup
  buckets through the DO is queued as unscheduled polish, not done here
  (RULES: no unasked rewrites of working modules).

- **M9 orgs/teams contract (session 14, do not regress)**:
  - **Membership + roles**: `orgs` + `org_members` (unique org_id+user_id).
    Roles: `owner` (rename/delete org, manage members incl. role changes,
    manage ANY org key, org top-up, rotate join code) and `member` (create +
    manage OWN org keys — `api_keys.user_id` = creator — view org usage +
    balance). Platform admin is GLOBAL: sees/manages every org via
    `/admin/orgs` without membership (incl. join codes). Last-owner guard:
    cannot demote/remove the only owner; owners cannot leave (delete org or
    transfer first); members can leave.
  - **Invites = join codes** (10 chars, unambiguous alphabet, UNIQUE column,
    create/rotate retries on collision) — Workers has no email sender. Codes
    are owner-only secrets in API responses (`join_code` undefined for
    members). Join is rate-limited per USER: `loginAllowed('org-join:<uid>',
    ip, 20)` — per-user beats per-IP here (authenticated surface; users
    behind one NAT never starve each other, and smoke re-runs within a minute
    no longer trip the shared IP bucket — that per-IP version burned the
    first smoke runs).
  - **Org balance**: `orgs.balance_usd_micros` + `balance_entries` rows with
    org_id set (user_id null — exactly one of the two is set). Org keys
    (`api_keys.org_id`) gate + debit the ORG balance at the gateway
    (429 `insufficient_quota` at ≤ 0 or org disabled; same soft/overshoot
    semantics as M8). Personal keys keep the M8 user-balance behavior.
    `debitBalanceUsage(env, {userId, orgId}, logId, cost)` is the single
    debit path (ledger ref `log:<id>` unique). Admin balance adjustments on
    an org are ledgered (`kind adjustment`, ref `adjustment:<uuid>`).
  - **Attribution**: `request_logs.user_id` = key's user (creator for org
    keys), `.org_id` = org — both written at insert; rows survive user/org
    deletion as the audit trail (dangling ids, same policy as M8). Admin
    logs + api-keys DTOs expose user_email/org_name via leftJoins.
  - **LS billing**: org checkout sends `checkout_data.custom.org_id` (no
    user_id); webhook credits the org when `custom_data.org_id` rides —
    org_id WINS over user_id when both are present; personal checkouts
    unchanged. Same two-layer idempotency (webhook_events + ledger ref).
  - **Delete-user succession (admin)**: a deleted owner's orgs pass to the
    longest-tenured remaining member (promoted to owner); an org with nobody
    left to inherit dies with its keys + ledger. All memberships of the
    deleted user are removed. Admin delete-org: members + org keys + org
    ledger + org row in one batch.
  - **Portal scoping**: personal `/app/api/keys`, `/usage` and `ownKey` now
    filter `isNull(api_keys.orgId)` — org keys NEVER appear on personal
    surfaces even though they have a creator user_id. Org surfaces live
    under `/app/api/orgs/*` (`routes/orgs.ts`, mounted alongside portal.ts
    at `/app/api`).
  - **404-not-403 policy** for org access (unknown org OR not a member both
    404 — no existence leak), matching ownKey.
  - **Smoke lesson (emails)**: signup LOWERCASES emails — fixtures must build
    lowercase addresses or admin-list lookups silently miss (burned the
    first smoke runs: `email('A')` produced uppercase).
  - **React lesson**: hooks (useMutation) must sit BEFORE conditional early
    returns in modal components — the admin EditOrgModal shipped with a hook
    after `if (!org) return null` and blanked the page when closed; caught by
    the browser pass, fixed by moving the hook up (Users.tsx pattern).

- **M8 accounts + MoR billing contract (session 13, do not regress)**:
  - **Balance model**: `users.balance_usd_micros` — integer micro-USD
    (1e-6 $) because per-request costs sit far below one cent. Debit =
    `Math.round(costUsd x 1e6)` per request in the gateway's `waitUntil`
    path; `balance_entries` is the audit ledger whose unique `ref`
    (`log:<id>` / `lemonsqueezy:order:<id>` / `adjustment:<uuid>`) makes
    every mutation idempotent. Pre-flight gate refuses at balance <= 0 with
    429 `insufficient_quota` (same envelope as the M7 spend cap — soft, may
    overshoot slightly under concurrency). Unknown cost (null pricing /
    missing usage) never debits. Admin keys (`api_keys.user_id` null) draw
    nothing.
  - **Lemon Squeezy webhook**: `POST /webhooks/lemonsqueezy`; auth = the
    HMAC-SHA256 hex `X-Signature` over the RAW body. Two-layer idempotency:
    `webhook_events` (unique source+event_key `<event_name>:<id>`) gates the
    delivery, `balance_entries.ref` unique guards the credit inside the same
    D1 batch as the balance bump (a conflict aborts the whole batch ->
    answered `{ok, duplicate}`). Credit = subtotal - discount_total
    (fallback total) for `order_created` + status 'paid' + not refunded —
    the MoR keeps the tax. Every parse-and-verify-but-don't-credit outcome
    (unknown user, pending, refunded, other events, missing custom_data) is
    recorded with a note and answered 200 so LS doesn't retry-loop; bad
    signature -> 401. Checkout creation (`POST /app/api/billing/checkout`,
    $1-500) sends `checkout_data: {email, custom: {user_id}}` which LS
    echoes back as `meta.custom_data`.
  - **public_signup setting**: default 'on' (the milestone's point is public
    signups), admin-toggleable on the Settings page; read UNCACHED and fail-
    CLOSED on DB error (signup is rare; enforcement's fail-open does not
    apply here).
  - **Password hashing**: PBKDF2-SHA-256 100k iterations via WebCrypto
    (no bcrypt on Workers), stored as `pbkdf2-sha256:<iters>:<salt-b64>:
    <hash-b64>` — verify honors the stored iteration count so the cost can
    be raised without migrating users. Email stored lowercase + unique.
  - **Cookies/sessions**: portal cookie `khateway_user` (30 d), separate
    `user_sessions` table; same HMAC+DB-row revocation pattern as admin —
    never downgrade to stateless-only.
  - **Rate-limit buckets**: `loginAllowed(bucket, ip)` — 'admin' and
    'portal-login' 10/min, 'portal-signup' 20/min and only counting
    validated attempts. Do NOT merge the buckets: smoke suites + one NAT
    share the limiter locally.
  - **drizzle-kit gotcha (fixed in schema.ts, keep it that way)**:
    `providers.adapters` is declared LAST with `.default('["openai"]')` to
    match the live column order/default left by hand-written migration 0002
    — declaring it in any other position/without the default makes
    `npm run generate` emit a full providers table recreate. Migration 0004
    was generated then hand-trimmed of that no-op recreate.
  - **UI routing**: portal lives at SPA paths `/app*` (assets) while its API
    is `/app/api*` (worker-first) — don't put portal API routes anywhere the
    SPA fallback would shadow, and don't drop `/app/api` from
    `run_worker_first`.
  - **Magic link / email verification deliberately deferred** (M8 ships
    email/password only) — Workers has no email sender; revisit if/when an
    email provider is chosen.

- **Keyless-native gateway default (session 11, user ask; do not regress)**:
  khode treats khateway as a keyless provider — users pick "khateway" and chat
  with NO client key. Khode's keyless wire contract (do not break): openai face
  `Authorization: Bearer anonymous`, anthropic face `x-api-key: anonymous`,
  model listing `GET /v1/models?limit=1000` (openai face) fetched BEFORE any
  chat — a 401 there breaks first-run. Gateway auth is therefore opt-in:
  `settings` row `client_key_enforcement` ('on'|'off', default off = absent),
  read through `db/settings.ts` with a 5 s isolate TTL cache (anonymous
  requests must not pay a D1 round-trip; read FAILS OPEN to keyless on DB
  errors). In default mode: no-auth requests, the literal `anonymous` sentinel
  (short-circuits BEFORE any key-DB lookup) and unrecognized tokens are all
  served anonymously; enrolled keys that verify still get caps/allow-lists and
  log attribution (request_logs.api_key_id null for anonymous). Enforcement on
  → strict M7 (401 without a valid enabled key; khode users set
  `KHATEWAY_API_KEY`). Admin: `GET/PATCH /admin/settings`; UI toggle on the
  API Keys page. Migration `0003_settings` was hand-written (simple CREATE
  TABLE) with the drizzle meta snapshot/journal edited by hand (same technique
  as 0002).
- **stream_options.include_usage (session 11)**: parsed into canonical
  `streamIncludeUsage` (removed from extras, so it never double-rides);
  openai adapter re-emits `stream_options:{include_usage}` for streaming
  requests (same-dialect passthrough now gets real usage from compliant
  upstreams); the anthropic→openai SSE translator takes `{includeUsage:true}`
  and emits the spec-shaped trailing usage-only chunk (`choices: []`) instead
  of riding usage on the finish chunk. Translated REQUEST paths never forward
  it (anthropic upstreams reject the param); responses-dialect parser drops it
  (no extras by design). Goldens pin all three legs (parse/adapter/SSE).

- **Rebrand + standalone move (session 9, 2026-09-17, user request): Rauter →
  Khateway; repo now at `~/Apps/khateway/`.** Outside the racode workspace — its
  workspace AGENTS/RULES no longer govern this project; the in-project docs trio
  is the only governance. Renames are now part of the contract: worker + D1 name
  `khateway`, cookie `khateway_session`, `x-khateway-*` headers, client key
  prefix `khat-`, synthetic IDs (`chatcmpl-khateway`, `resp_khateway`,
  `msg_khateway`). Local D1 was refreshed right after (user-approved wipe), so
  **no legacy `raut-` keys or old-brand rows exist** — new keys mint as `khat-`
  only; the placeholder `database_id` stays until the real M8 deploy creates
  the remote DB.
- **Audience amended (session 8, 2026-09-17): Khateway is going PUBLIC** (was internal-only). **Stripe is excluded** — no Cambodia merchant support. Billing direction = **merchant-of-record**, shortlist **Lemon Squeezy** (first pick — Cambodia explicitly in its bank-payout countries, payouts in USD via bank/Payoneer) / **Paddle** / **Polar**; MoR owns global VAT/GST, invoices, and payouts. KHQR/Bakong merchant QR if selling locally in Cambodia; stablecoin processors (NOWPayments/Cryptomus etc.) optional later but KH regulatory posture is gray — decide deliberately. Consequences: M8 adds public-grade user accounts, M9 orgs/teams, and **M10 rate limiting is a public-launch blocker**.

- **Golden-fixture suite conventions (session 7)**: fixtures are arrays of `{name, …input, expected}` JSON in `tests/fixtures/`; runners in `tests/worker/` stay thin. Wall-clock `created`/`created_at` are frozen to `"<now>"` via `freezeTimestamps` — never hand-write epoch values in goldens (the `created`-passthrough case is pinned by an inline test instead). Adapter fixture keys are plaintext + `"apiKeyEnc": "RUNTIME"` marker; the runner encrypts at runtime with a fixed 32-byte test ENCRYPTION_KEY (ciphertexts embed a random IV → cannot be pre-baked). When behavior changes deliberately, update the golden to the new expected output in the same commit — the diff is the review artifact. Don't port routing/DB/gateway-orchestration tests into vitest; those need D1/HTTP and belong to the smoke scripts.
- **Translation asymmetries pinned by goldens (do not "fix" silently)**: the JSON `anthropicMessageToOpenAiCompletion` keeps the full upstream id (`chatcmpl-msg_01ABC` — no prefix strip), while the SSE translators strip `msg_`/`chatcmpl_`; `foldOpenAiContent` (openai→anthropic) folds only `text` parts (refusal parts are dropped) while the responses-side `textOfOpenAiContent` folds refusal too; `functionCallItemId` strips only `call_`/`fc_` prefixes, so anthropic `toolu_…` ids become `fc_toolu_…`.

- One deployable Worker: SPA static assets + `/v1` + `/admin`. `run_worker_first` for `/v1/*`, `/admin/*`, `/health`.
- Three adapters since M12: `openai` (also OpenAI-compatible vendors via base_url override — Groq/DeepSeek/xAI/OpenRouter/Ollama/Gemini-compat), `anthropic`, and `gemini` (native generateContent — see the M12 contract). Azure small variant defer; Bedrock defer.
- **Multi-adapter providers (session 10, do not re-litigate)**: `providers.adapters`
  is a JSON array of known adapters (`parseAdapters` in routing.ts is the single
  parser). A dual-dialect provider (OpenRouter/LiteLLM/AI Gateway/…, or any
  proxy exposing both /chat/completions and /v1/messages) is ONE row with ONE
  shared base URL — the gateway picks the adapter per request: client-dialect
  match first (`preferredAdapter`; `/v1/responses` → openai), and on
  `UnsupportedTranslationError` the SAME candidate is retried through its other
  adapter before the fallback chain advances (misconfig skips the whole
  provider; timeout/network/429/5xx end the provider's turn). `attempts`
  counts adapter tries + fallbacks. URL rule: one openai-style `/v1` base
  serves both adapters — `joinAdapterUrl` (env.ts) strips the trailing `/v1`
  for anthropic paths so `/v1` + `/v1/messages` never doubles up. Admin API:
  `adapters` array is canonical; legacy `adapter` string accepted and coerced;
  DTOs expose `adapters` array AND `adapter` scalar (first). The M12 prediction
  held: native Gemini = KNOWN_ADAPTERS entry + an adapter module + URL rule,
  no schema change. Anthropic-adapter URL contract amended accordingly: shared
  bases may end in `/v1` now (stripped); bare-origin bases unchanged.
- Model slugs are globally unique platform ids; slug pattern disallows `/` (reserved for `provider/slug` pinning + fallbacks later).
- Session auth: HMAC-signed HttpOnly cookie **+ sessions table row** (revocable). Never downgrade to stateless-only. In-memory login rate-limit per isolate accepted for MVP.
- Encryption: provider keys AES-256-GCM with `ENCRYPTION_KEY` (32B base64); key_hint (last 4) is the only unencrypted trace. Client keys (M7) = sha-256 hash only.
- DTO convention: snake_case over the wire, camelCase in the DB.
- Gateway architecture (M3): `canonical.ts` is types-only (canonical chat request); wire logic strictly in `dialects/` (client-facing), `adapters/` (upstream-facing), `routes/gateway.ts` (orchestration). Unknown client fields ride in `extras` and pass through verbatim to openai-compatible upstreams.
- Error mapping policy: upstream HTTP status is PRESERVED for 4xx/5xx (retry-aware clients), only the envelope/type is derived (status→OpenAI type); gateway-generated failures: 404 model_not_found (unknown/disabled), 502 network, 504 timeout-after-N-ms, 500 provider_misconfigured (bad stored key), 501 upstream_dialect_unsupported (M4+ pairing).
- Streaming = raw passthrough (openai→openai identity); adapter timeout budget applies to response HEADERS only — long SSE streams are deliberately never cut off by it.
- M4 translation policy: same-dialect pairings passthrough untouched; cross-dialect pairings translate requests/responses/SSE via the canonical form. Translation logic lives by OUTPUT dialect (openaiChat.ts emits openai shapes incl. from anthropic input; anthropicMessages.ts emits anthropic shapes incl. from openai input); generic SSE byte framing in dialects/sse.ts.
- Cross-dialect error policy: upstream HTTP status always preserved; upstream-declared error type preserved too (openai/anthropic vocabularies overlap; the anthropic SDK classifies by status anyway) — only foreign-vocabulary names are mapped (openai-only ↔ anthropic-only tables); absent types derived from status.
- Anthropic adapter contract: provider base_url has NO `/v1` (bare origin; adapter appends `/v1/messages` — matches admin test-connection); Messages `max_tokens` is REQUIRED and defaults to model.max_output_tokens ?? 4096 when the caller's dialect omits it; system/developer messages fold into the top-level `system` param; consecutive same-role turns merged; assistant-first conversations and `n>1` are rejected 400 `untranslatable_request` (explicit, not silently mis-shaped).
- Anthropic parse contract: max_tokens REQUIRED (dialect-faithful), temperature validated 0..1 (anthropic spec), stop_sequences ≤16, `top_k`/`metadata` ride in extras (other openai extras are dropped for anthropic upstreams — the Messages API rejects unknown params).
- Translated streams are fully incremental (TransformStream, no body buffering). Translated openai chunk streams carry usage on the final chunk; translated anthropic streams report input_tokens=0 until an upstream usage chunk arrives (openai only sends one with stream_options). If an upstream ignores stream:true and returns JSON, Khateway translates the JSON as-is (no SSE synthesis) — deliberate scope cut.
- **M5 responses dialect contract**: `/v1/responses` is a CLIENT dialect only — per plan §2 there is NO responses upstream adapter (`openai` adapter always builds `/chat/completions`), so every responses pairing is translated and there is no passthrough cell for it. Parse: `input` = string or message items (input_text/output_text/refusal parts folded; images/function items → M6 400 pointers); `instructions` → leading canonical system message; `max_output_tokens` (int ≥ 16, optional) → canonical maxTokens emitted downstream as `max_tokens` (most portable across openai-compatible upstreams; Messages adapter always emits max_tokens anyway); temperature 0..2 / top_p 0..1; stateful params (`previous_response_id`, `prompt`, `item_reference`) are rejected 400 because Khateway is a stateless router — silent drops would change conversation semantics; responses-only params with no canonical home (store, truncation, include, text, metadata, service_tier, …) are dropped deliberately. Output: Responses objects/events (`resp_*` / `msg_*` ids, `sequence_number` on every event, `status` completed|incomplete + `incomplete_details` derived from finish/stop reason, `response.failed` for mid-stream errors and content-less streams). Errors use the OpenAI envelope (shared with the chat dialect).
- Tools/vision pre-M6 were rejected 400 with M6 pointers; since M6 they are translated (see the M6 contract above). Still rejected 400: vendor-hosted tools (openai `web_search` etc., anthropic server tools) and the legacy `functions`/`function_call` API.
- **M6 tools/vision contract**: tool arguments travel canonically as a JSON **string** (the openai encoding; anthropic parses to `input` objects, responses passes through). Tool-choice map: `'auto'`↔`{type:'auto'}`, `'required'`↔`{type:'any'}`, `{name}`↔`{type:'tool',name}`, `'none'`→ tools omitted from anthropic requests entirely; `parallel_tool_calls:false` ↔ `disable_parallel_tool_use:true`. Vendor-hosted tools (openai `type:'web_search'` etc., anthropic server tools) and the legacy `functions`/`function_call` API are rejected 400 — hosted tools execute inside one vendor's cloud and cannot be routed across dialects. Images travel canonically as URLs (data: or https); the anthropic adapter splits data URLs into base64 sources and passes https through as url sources, the openai adapter rebuilds `image_url` parts (openai `detail` hint preserved openai-side only). Intra-message text/image ordering is NOT preserved across dialects (folded text first, images appended) — deliberate simplification. Tool result `is_error` rides per-message extra (preserved to anthropic tool_result, rides verbatim in extras to openai upstreams). Responses translation: the message output item opens lazily so tool-only turns produce function_call-only output; function_call item ids are `fc_<callid-without-prefix>`; tool-argument fragments stream as `response.function_call_arguments.delta` and finalize via `.done` + `output_item.done` at close.
- **M6 fallback policy**: the gateway walks `primary + models.fallbacks` (each entry resolved like a `model` field, so `provider/slug` pins may cross providers/adapters; unknown/disabled/already-visited entries are skipped; cap 10 = admin CRUD limit). Failover triggers on upstream 429/5xx, timeout, network failure, and per-candidate build errors (provider misconfigured / request untranslatable for that adapter). Client-caused 4xx (except 429) surface immediately. When the chain is exhausted the LAST failure is mapped; every gateway response carries `x-khateway-attempts` (1 = primary). No backoff, no `Retry-After` handling (deliberate scope cut — candidates for later polish). **Amended session 10**: untranslatable requests ARE retried on the same candidate when its provider declares a second adapter (that "no same-candidate retries" clause is superseded); single-adapter providers behave exactly as before.
- `scripts/smoke_gateway.mjs` runs a mock OpenAI upstream on 127.0.0.1 (ephemeral port) — workerd fetches localhost fine in wrangler dev local mode. Fixtures are named `… (smoke)` and self-cleaned (providers, models, AND api keys); never assert on other rows in local D1. Since M7 every `/v1` call in the smoke authenticates as the `Smoke Key (smoke)` client key created at run start.
- **M7 client-key contract**: keys look like `khat-<32hex>`; DB stores sha256(key_hash, unique) + `key_prefix` (`khat-xxxx`) for the UI; the raw key is returned exactly once in the create response and never stored. Gateway auth accepts BOTH `Authorization: Bearer` (OpenAI SDKs) and `x-api-key` (Anthropic SDK drop-in — M4 promise). 401 envelopes follow the path dialect (`/v1/messages` → anthropic `authentication_error`, else openai). Unknown/disabled key → same 401 message (no existence leak). Gateway 401s are NOT logged; every request that passes auth writes exactly one request_logs row (even client-4xx/404/parse errors — model_slug `(unknown)` when parsing failed before model extraction). `request_logs.dialect` uses the schema vocabulary `chat|responses|messages` (mapped from the internal dialect names — don't regress to `openai|anthropic`).
- **M7 usage/cost capture contract**: non-stream JSON → usage read from the upstream payload (translated pairings) or a content-aware tee'd-branch watcher (passthrough JSON needs its own JSON parse — SSE framing assumptions silently miss it, burned session 6). SSE → upstream body tee'd, `dialects/usage.ts` `watchUpstreamSseUsage` resolves under `c.executionCtx.waitUntil`, then UPDATEs the row (openai: last chunk usage; anthropic: message_start input + message_delta output). `costUsd = tokens/1e6 × pricing`, but null pricing ⇒ null cost (unknown ≠ free; explicit 0/0 pricing ⇒ $0, which is how the user's subscription-based z.ai fixture is modeled).
- **M7 caps contract**: spend cap = pre-flight SUM(cost_usd) per key vs `spend_limit_usd` → 429 `insufficient_quota`/`spend_limit_exceeded` (soft cap, no reservation accounting). `allowed_models` empty/absent = all models; otherwise the PRIMARY resolved slug must be listed → else 403 `permission_error`/`model_not_allowed`. Both enforced in the pipeline after parse, before routing work that needs the model.
- **z.ai coding plan (user's provider)**: base_url must be `https://api.z.ai/api/coding/paas/v4` for coding-plan keys; `/api/v1` authenticates but denies all models; `/models` returns HTTP 200 with an auth-error JSON body (code 1000) — so admin test-connection (which checks HTTP status only) shows ok:true even for bad z.ai keys. glm-5.3-flash is a reasoning model: responses carry `reasoning_content` and burn output tokens before the visible text.

## Feature status snapshot

See `STATUS.md` (kept live there — it is the resume point). **M1–M7 done — MVP COMPLETE** (admin console; gateway core; anthropic dialect + cross-dialect translation matrix with SSE both ways; `/v1/responses` third client dialect; tools/vision translation across all dialects + fallback chains & retries; client API keys + spend caps + allowed-model lists + request logs with usage/cost capture + logs UI + snippets — live-verified against z.ai; multi-adapter providers since session 10; keyless-native default since session 11; **M8 portal accounts + prepaid balances + Lemon Squeezy billing since session 13**; **M9 multi-user orgs/teams with shared org balances since session 14**; **M10 gateway rate limiting (Durable Object, per-key/per-IP/per-model, 429 + Retry-After) since session 15**; **M11 semantic cache (canonical-hash entries, opt-in per model/key, TTL + flush) since session 17**; **M12 native Gemini adapter (generateContent upstream, thinking budgets, native multiparts) since session 18**; **M13 embeddings (`POST /v1/embeddings` — openai + native-gemini upstreams, logged + priced like chat) since session 19**). The **offline golden-fixture vitest suite** (266/266) is the regression net over the wire surface (plus password/LS-webhook/rate-limit/cache-key/gemini/embeddings units).

## Known rough edges

- **Spend cap is a soft cap** (pre-flight sum, no reservation accounting) — concurrent in-flight requests can overshoot. Same for the M8 prepaid balance and the M9 org balance (may drift slightly negative under concurrency). Fine internally; don't "fix" without asking. M10 rate limits are fixed 1-minute windows: up to 2× the limit can pass across a window boundary — standard tradeoff, fine for abuse control.
- **Rate-limit counters reset if the DO restarts mid-window is NOT a risk** (SQLite-backed), but a DO eviction between requests just means a fresh counter row — first-request-after-idle re-counts from 1. Bounded and acceptable; don't add per-request storage puts without asking.
- **`smoke:m8` leaves `webhook_events` rows behind** (per-run random order ids; kept deliberately as the audit trail) — the only smoke residue in local D1. Models with null pricing cost users AND ORGS nothing (debit skips unknown cost) — same "unknown ≠ free" caveat as logs, but balance-side it means free usage; give models pricing before selling access.
- Gateway auth-failures are not logged to request_logs (only requests that pass the auth gate). Anonymous (keyless) requests DO log with `api_key_id` null. If logging auth failures matters too, that's a new decision.
- A mounted Hono sub-app's `notFound()` is bypassed by the root app — the gateway owns unknown `/v1/*` paths via a wildcard `all('*')` route (returns OpenAI-shaped 404). Don't "simplify" it back to notFound().
- No CSRF hardening on /admin (SameSite=Lax, HttpOnly, single-origin same-Worker). Acceptable internal; revisit if ever exposed publicly.
- The local D1 has real user fixtures (provider KiosAPI — now unused; provider Z.ai serving slug `glm-5.3-flash`) that smoke scripts must never delete; smoke fixtures are `… (smoke)`-named and self-cleaning (incl. api keys).
- Deploy needs: ~~real D1 `database_id` (placeholder in wrangler.jsonc), `wrangler secret put ADMIN_PASSWORD` + `ENCRYPTION_KEY`~~ **DONE (session 21 — deployed to khateway.chengsokdara.workers.dev; see the M15 contract)**.
- **Request bodies are always rebuilt from canonical** (even same-dialect pairings — only responses/SSE relay untouched), so dialect-specific fields Khateway doesn't model are lost: anthropic block-level `cache_control` (prompt caching does not survive Khateway today), openai message-level extras other than `name`-style passthrough, and intra-message text/image ordering. If prompt caching matters, that's a canonical-extensions decision, not a bug fix.
- SSE fragment assertions in smoke must **parse events** (`parseSseEvents`/`parseDataLines`) — JSON escaping hides fragment content from substring matching (burned session 5 twice).
- Z.ai quirks (see M7 contract above): coding-plan keys only work on the `/api/coding/paas/v4` base; `/models` returns HTTP 200 with auth-error bodies, so admin test-connection can't detect a bad z.ai key.

- **Bidirectional /v1 URL rule (session 10, pinned by tests)**:
  `joinAdapterUrl` accepts base URLs pasted with OR without `/v1` for BOTH
  adapters. Rules: last segment exactly `v1` → kept for openai, stripped for
  anthropic (any path shape: `/v1`, `/api/v1`); bare origin (no path) → kept
  for anthropic, `/v1` INSERTED for openai; any other custom path is never
  modified (z.ai `/api/coding/paas/v4`, Gemini-compat `/v1beta/openai` must
  not gain `/v1`). The openai-insert rule is deliberately conservative —
  only bare origins — because appending `/v1` to arbitrary vendor paths is
  unsafe; that asymmetry is intentional, don't "generalize" it.
- **Vendor URL facts (verified 2026-09-17, do not "fix" without checking)**:
  OpenRouter serves POST /api/v1/chat/completions AND POST /api/v1/messages
  from server URL `https://openrouter.ai/api/v1` (its OpenAPI spec: servers
  = /api/v1, paths include /messages) — a dual-dialect provider with that
  base works through joinAdapterUrl's /v1-strip rule. LiteLLM proxy serves
  /v1/chat/completions and /v1/messages (docs.litellm.ai/docs/anthropic_unified).
  Anthropic itself: bare origin, /v1/messages appended by the adapter.
  These facts back the presets in `src/shared/vendor-urls.ts`.
- **Shared module boundary**: `src/shared/` is imported by BOTH worker and
  web — it must stay dependency-free and free of Workers-only types (that's
  why the Adapter type lives in `src/shared/adapters.ts`, re-exported by
  `worker/env.ts`; tsconfig.worker/web/test all include src/shared).
- **Model discovery/import contract (session 10)**: upstream `/models` listings
  are normalized (not relayed): openai shape and anthropic `/v1/models` both
  yield `{id, display_name, context_window, max_output_tokens}` with best-effort
  field extraction (`context_window`/`context_length`, anthropic
  `display_name`), deduped by id, capped at 500. Import maps slug = upstream id
  and skips (never 4xx) existing slugs and ids outside the slug alphabet —
  import is idempotent-ish and re-runnable. The unsaved-form probe encrypts the
  provided key in memory (never persisted) — same AES path as saved keys.
  Mock /models fixture in smoke_gateway serves 4 entries incl. one invalid slug
  to pin the skip behavior; import check tolerates re-run state.
- **Dev workflow (session 10)**: `npm run dev` IS the one-terminal hot-reload
  runner (wrangler :8787 + vite :5173 via zero-dep `scripts/dev-all.mjs` —
  user request to make it the default; `dev:all` kept as alias, `dev:prod` =
  old built-bundle-on-:8787 behavior). The script tags every line
  `[worker]`/`[ui]`, stops both children on Ctrl-C, fail-fasts if either
  dies, and builds `web-dist/` once when missing (fresh-clone safety).
  Browse :5173 for UI work. Gotcha: vite binds `localhost` (IPv6 ::1), so
  `curl 127.0.0.1:5173` gets ECONNREFUSED — test with `localhost`, or the
  browser/proxy path which is unaffected.
- **Vite proxy must list every worker API prefix the SPA calls (session 16)**:
  the proxy predates the M8 portal and only had /admin,/v1,/health, so on
  :5173 every /app/api call 404'd (portal signup "Request failed (HTTP 404)")
  while the same UI worked on :8787 (dev:prod) — a silent "works in
  prod-style, breaks hot-reload" split. Fixed by proxying `/app/api` +
  `/webhooks` too. Rule: any new worker route prefix (run_worker_first in
  wrangler.jsonc is the source of truth) must be mirrored into
  vite.config.ts's proxy or hot-reload UI silently 404s it.

## How to verify health quickly

```bash
cd khateway
npm run migrate:local && npm run dev     # :8787, ADMIN_PASSWORD=khateway-admin (.dev.vars)
curl -s localhost:8787/health            # {"ok":true,...}
npm run check                            # tsc worker + web + tests
npm test                                 # 266 vitest tests (offline, no server needed)
node scripts/smoke.mjs                   # admin API flow (needs dev server running)
npm run smoke:gateway                    # full /v1 pipeline via mock upstream (needs dev server running)
npm run smoke:m8                         # accounts/balance/LS-webhook e2e (needs dev server running)
npm run smoke:m9                         # orgs/members/keys/org-balance/webhook e2e (needs dev server running)
KEY=$(...)                               # optional: a client key from the API Keys page
curl -s localhost:8787/v1/models         # OpenAI list envelope — works with NO key by default
                                         # (enable client-key enforcement, then pass
                                         #   -H "authorization: Bearer $KEY"; else 401)
```

## User preferences learned

- Plan mode = discussion only; user explicitly approves before implementation (learned the hard way in termagent).
- **khode is khateway's first external client (2026-09-17):** the user's Go
  coding agent at `~/Apps/khode` ships **khateway as a built-in provider**
  (khode commits 662958b + e487bc9). Contract khode relies on — do not break
  without asking: `GET /v1/models` (openai shape, `Authorization: Bearer
  khat-…` accepted), `POST /v1/chat/completions` (Bearer), `POST /v1/messages`
  (`x-api-key` + `anthropic-version`). Khode picks the SDK client from the
  base-URL shape (`…/v1/messages` → anthropic face, else openai face); the
  openai face (`http://localhost:8787/v1` default) is the recommended config.
  **Live e2e (session 11, all green):** khode's real llm layer → wrangler dev
  + local mock upstream: FetchModels OK; streamed turn openai-face (content
  + usage 12/7); cross-dialect streamed turn anthropic-face; request_logs
  rows for both dialects with usage + cost $0 (0/0 pricing fixture).
  Wrangler dev dies when its parent shell exits — run server + client in ONE
  invocation for live tests. The user's goal: ride other providers configured
  in khateway (e.g. the z.ai coding plan) as free models for khode.
- Wants the docs trio + live STATUS.md per project, mirrored by workspace-level racode/AGENTS.md + racode/RULES.md; STATUS.md is the **interruption resume point** — update it while working, not only after tasks.
- Likes professional, easy-to-use UI; vendor-light dependency policy; English for code/chat unless other language used.
- TermAgent exists in the same workspace and its docs/conventions were the template user likes.
