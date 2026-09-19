# STATUS.md — Khateway live status

Last updated: 2026-09-19 (session 21 — M15 hardening + real deploy)

## How to use this file

Kept current **while working** (not just after tasks) so an interrupted session
can resume: check "Current work state" for what's in flight, "Roadmap" for
where the milestone plan lives, "Recent changes" for history (newest first).
If something is claimed ✅ but not verified, it says so.

## Current work state

- **M15 — pre-launch hardening + REAL DEPLOY ✅ complete (session 21,
  2026-09-19)** — user picked all four queued packages (M15 hardening+deploy →
  M16 parity pack → M17 reasoning → M18 structured outputs) after a
  codebase-wide audit (2 exploration passes + hand verification). M15 shipped:
  - **Webhook money-loss fix** (`routes/webhooks.ts`): the `webhook_events`
    row is now written in the SAME atomic D1 batch as the credit (ledger +
    balance bump); the old gate-1-then-credit order meant a transient D1
    failure was answered `{ok,duplicate}` (LS never retries) and even a 5xx
    retry would have been blocked as a duplicate without crediting. New
    exported `isUniqueViolation(err, table)` walks the drizzle cause chain for
    `UNIQUE constraint failed: <table>.` (trailing dot = exact table match);
    unique → duplicate 200, anything else → throw → 500 so LS retries into a
    clean state. Non-crediting outcomes record-with-note at insert (no more
    noteAndFinish UPDATE). Pinned by `tests/worker/webhook-errors.test.ts`
    (4 tests); smoke_m8 43/43 green.
  - **`request_logs.api_key_id` index** (migration `0009_m15_log_indexes`,
    generated + renamed + journal tag hand-edited, applied local + REMOTE):
    the spend-cap SUM ran on every keyed request against an unindexed
    append-only table. Portal `keyUsage` now SQL `SUM`+`count` (mirrors
    admin) — the unbounded row-load + N+1 in `GET /keys` is gone.
  - **PATCH /users/:id + /orgs/:id**: `balance_adjust_usd` validated BEFORE
    the enable/disable toggle applies (no partial application on 400).
  - **Root `onError`**: generic `Internal server error` 500 (raw err.message
    with SQL fragments never reaches clients); Hono `HTTPException`
    (from `hono/http-exception`) passes through.
  - **Doc drift**: README milestones through M14 + new `/app` portal section;
    App.tsx sidebar footer "M1–M14 · development"; `UserInsert` → `UserRow`.
  - **REAL DEPLOY ✅** — https://khateway.chengsokdara.workers.dev — remote
    D1 `khateway` created (id in wrangler.jsonc, placeholder gone), all 10
    migrations applied `--remote`, Worker deployed (RATE_LIMITER DO + DB +
    ASSETS bindings verified), secrets set: `ENCRYPTION_KEY` (freshly
    generated, piped, never displayed) + `ADMIN_PASSWORD` (the .dev.vars
    value, piped — ROTATE ANYTIME via `npx wrangler secret put
    ADMIN_PASSWORD`). Verified on the deployed URL: /health ok, keyless
    /v1/models 200 (empty list — fresh DB), bogus-model chat → 404 openai
    envelope (auth→parse→routing→D1 all live), admin login 200, SPA root 200.
  - **git initialized** (was unversioned!): repo on `main`, .gitignore covers
    node_modules/.wrangler/web-dist/.dev.vars/.video_agent/.zcode; commits:
    initial (M1–M14) + M15 hardening.
- **Next: M16 — OpenRouter client-parity pack** (per the user's chosen
  sequence): /v1/models pricing + supported_parameters, client /api/v1
  key+credits endpoints, legacy /v1/completions, attribution headers, DO
  count/limit/reset exposure + x-ratelimit success headers, usage:{include},
  SSE keep-alives. Then M17 reasoning/thinking, M18 structured outputs.
- **MVP M1–M7 ✅**; **M8 ✅ (session 13)**; **M9 ✅ (session 14)**; **M10 ✅
  (session 15)**; **M11 ✅ (session 17)**; **M12 ✅ (session 18)**; **M13 ✅
  (session 19)**; **M14 ✅ (session 20)**.

## Verification baseline (2026-09-19, session 21)

- `npm run check` — clean (worker + web + test tsconfigs)
- `npm test` — **270/270** (+4: webhook unique-violation discrimination)
- `npm run build:web` — clean (408.3 KB js / 112.4 KB gzip)
- `npm run migrate:local` — `0009_m15_log_indexes` applied
- All seven smokes re-run post-M15: `npm run smoke` green (exit 0),
  `smoke:gateway` **176/176**, `smoke:m8` **43**, `smoke:m9` **75**,
  `smoke:m10` **33**, `smoke:m11` **ALL PASS (30)**, `smoke:m14` **ALL PASS (24)**
- Deploy verification: see the M15 block above (remote /health, /v1/models,
  chat 404 envelope, admin login, SPA — all green)

- **M14 — playground UI ✅ complete (session 20, 2026-09-19)** — "Let's go
  M14"; scope per ROADMAP.md's M14 row: in-admin chat tester hitting the
  gateway with a session-scoped key. Shipped:
  - **Session-scoped client keys**: new `api_keys.playground_session` column
    (migration `0008_m14_playground`, one ALTER) holding the sha256 of the
    admin session token a key belongs to. `POST /admin/playground/key`
    (adminAuth) ROTATES — deletes the session's previous key, mints a fresh
    `khat-` key (name 'Playground', no spend cap, no model restrictions) and
    returns the raw key once (hash-only storage, same one-time-reveal contract
    as POST /api-keys). Playground keys are session-derived state: hidden from
    `GET /admin/api-keys` (`isNull(playgroundSession)`), deleted at logout,
    and swept when their session row is gone/expired (leftJoin sweep on mint).
  - **Web `pages/Playground.tsx`** (nav after Models, `MessageSquare` icon):
    model picker (enabled models only, provider-labeled, pricing/ctx meta
    line), temperature + max-tokens params, system prompt, transcript with
    streaming assistant render (SSE parse of the openai chat dialect —
    `stream_options.include_usage` sent so streamed usage lands in logs),
    Stop (AbortController) + Clear, Enter-to-send. After each completion it
    polls `GET /admin/logs?api_key_id=<session key>` (log writes land in
    waitUntil after the stream) and renders the resulting rows (status, model,
    dialect, tokens, exact cost, latency, cache badge, error).
  - **StrictMode-safe minting**: `api.createPlaygroundKey()` dedupes the
    double-mount with a shared inflight promise — both mounts share ONE key
    (a second mint would revoke the first's key, since mint = rotate).
  - **Gateway: zero changes** — a playground key is an ordinary enrolled key;
    it rides the same auth/gates/fallback/logging path (that's the point) and
    satisfies `client_key_enforcement: 'on'`.
  - **No new vitest files** (orchestration surface only — the mint/rotate/
    sweep/logout lifecycle is pinned end-to-end by `scripts/smoke_m14.mjs`).
- **Next active milestone: none scheduled** — the user's stated post-MVP
  order (payments → orgs → rate limiting → cache → Gemini → embeddings →
  playground) is exhausted; unscheduled polish queue lives in ROADMAP.md.
- **MVP M1–M7 ✅**; **M8 ✅ (session 13)**; **M9 ✅ (session 14)**; **M10 ✅
  (session 15)**; **M11 ✅ (session 17)**; **M12 ✅ (session 18)**; **M13 ✅
  (session 19)**.

## Verification baseline (2026-09-19, session 20)

- `npm run check` ×3 — clean (worker + web + test tsconfigs)
- `npm test` — **266/266** (unchanged; no new unit files in M14)
- `npm run build:web` — clean (408.3 KB js / 112.4 KB gzip, +9 KB playground)
- `npm run migrate:local` — `0008_m14_playground` applied (local D1)
- `npm run smoke` — admin API flow green (exit 0)
- `npm run smoke:gateway` — **176/176**
- `npm run smoke:m8` — **43/43**; `npm run smoke:m9` — **75/75**;
  `npm run smoke:m10` — **33/33**; `npm run smoke:m11` — **ALL PASS (30)**
- `npm run smoke:m14` — **ALL PASS (24 checks)** (new: unauth mint 401, mint
  shape + one-time key, hidden from /admin/api-keys, /v1/models + streamed
  call with include_usage through the key, assembled text + [DONE] + usage
  chunk + attempts=1, log row with exact $0.000054 at $2/$8 per 1M + 'Playground'
  attribution, re-mint rotation (old key 401 under enforcement), current key
  satisfies enforcement 'on', logout revokes the session key, fresh session
  mints + calls again; enforcement restored 'off', fixtures + logs cleaned)
- Browser pass (vite :5173 hot-reload): /playground renders nav + key badge +
  model picker (user's real kios-live-test models untouched) + pricing meta;
  streamed round-trip against a local mock model (pg-browser) rendered the
  user + assistant bubbles and the log card row (200 · 9 in / 6 out ·
  $0.000066 exact · 3 ms). IAB locator clicks flaky as usual — drove the send
  via page-side events (known, not a product bug). Fixtures deleted, logs
  cleared afterwards.
- Live-provider verification: not run (playground exercised against the local
  mock upstream; the user's real providers untouched).

- **M13 — embeddings ✅ complete (session 19, 2026-09-19)** — "Let's go M13";
  scope per ROADMAP.md's M13 row: `POST /v1/embeddings` end-to-end — routing,
  client-key auth, logs + cost — the first non-chat pipeline branch. Shipped:
  - **OpenAI Embeddings client face** (the only embeddings client dialect —
    Anthropic has none). New `dialects/openaiEmbeddings.ts` parses
    `{model, input: string | string[], dimensions?, encoding_format?}` into a
    new `CanonicalEmbeddingsRequest` (canonical.ts) — input normalized to
    `string[]`, pre-tokenized integer arrays rejected 400 explicitly, unknown
    fields → `extras` (openai passthrough). Errors are always OpenAI-envelope
    (the auth middleware already answered 401s that way on this path).
  - **Two upstream adapters**: openai-compatible `POST {base}/embeddings`
    (response RELAYED untouched — usage captured by the existing JSON
    tee-watcher, exactly like passthrough chat) and native Gemini
    `POST {base}/models/{m}:embedContent` (single text) /
    `:batchEmbedContents` (arrays — one request entry per input, embeddings
    come back in order) with `x-goog-api-key`. Gemini body:
    `model: "models/{id}"` + `content:{parts:[{text}]}`, options under
    `embedContentConfig` (openai `dimensions` → `outputDimensionality`,
    openai-style `task_type`/`title` extras → `taskType`/`title`; other
    extras dropped like chat). Wire facts verified 2026-09-19 against
    ai.google.dev/api/embeddings. Gemini responses normalized onto the openai
    list shape by `geminiEmbeddingsToOpenAi` (dialects/gemini.ts) —
    `encoding_format: 'base64'` packs floats client-side
    (`floatsToBase64`, little-endian float32) since gemini returns arrays.
    Gemini `usageMetadata.promptTokenCount` feeds BOTH the response usage and
    the log row — gemini embeddings DO log tokens (verified: both embeddings
    endpoints return usageMetadata).
  - **Shared pipeline gates extracted** from chatPipeline into
    `enforceSpendCap` + `enforcePostRoutingGates` (rate limits → allow-list →
    balance; M8/M9/M10 behavior byte-identical — all chat smokes re-green)
    plus a `makeWaitUntil` helper; the embeddings pipeline reuses them, so
    client-key auth (middleware, path-agnostic), spend caps, rate limits,
    allow-lists and personal/org balance gates + debits apply to embeddings
    with zero new code. Fallback chain walk is the chat skeleton minus
    translation/caching: 429/5xx/timeout/network → next candidate; client 4xx
    surface immediately; anthropic-only providers answer **501
    `upstream_dialect_unsupported`** (no embeddings endpoint exists there).
  - **Logs/cost**: every embeddings request writes a `request_logs` row with
    `dialect: 'embeddings'` (plain text column — NO migration); usage =
    tokensIn from upstream (openai `usage.prompt_tokens` / gemini
    `usageMetadata.promptTokenCount`), tokensOut null (embeddings have no
    output tokens), cost = tokensIn × `pricing_input` (input-only pricing —
    set `pricing_input` on embedding models; null pricing still means null
    cost / no debit). Balance debits ride the same waitUntil path as chat.
  - **Semantic cache does NOT apply** (M11 eligibility gate is chat-shaped —
    deliberate; widen `evaluateCacheEligibility` before ever caching
    embeddings). No streaming, no tools, no translation matrix.
  - **UI**: Logs page gains the `/embeddings` dialect option + label (the
    whole UI delta — no new pages/cards).
  - **No migration, no new bindings/routes prefixes** (`/v1/embeddings` rides
    the existing `/v1` worker-first + vite proxy entries).
- **Next active milestone: M14 — playground UI** (per ROADMAP order).
- **MVP M1–M7 ✅**; **M8 ✅ (session 13)**; **M9 ✅ (session 14)**; **M10 ✅
  (session 15)**; **M11 ✅ (session 17)**; **M12 ✅ (session 18)**.

## Verification baseline (2026-09-19, session 19)

- `npm run check` ×3 — clean (worker + web + test tsconfigs)
- `npm test` — **266/266** (+23: embeddings request-build goldens ×7
  [openai single/array/dimensions/extras/bare-origin, gemini embedContent/
  batchEmbedContents/embedContentConfig/bare-origin], client parse goldens
  ×11 [valid shapes + rejections incl. pre-tokenized arrays], gemini→openai
  normalize goldens ×5 [single/batch/no-usage/defensive/base64 round-trip])
- `npm run build:web` — clean (399.6 KB js / 109.7 KB gzip)
- `npm run migrate:local` — not re-run: **no migration in M13** (schema
  untouched; `request_logs.dialect` is a plain text column, vocabulary gains
  'embeddings' by convention)
- `npm run smoke` — admin API flow green (exit 0)
- `npm run smoke:gateway` — **176/176** (+17 M13 checks: openai face single/
  array + dimensions passthrough + upstream path/model assertion, log rows
  with dialect 'embeddings' + input-only cost $0.000006 at $2/1M (3 tokens),
  array 6 tokens → $0.000012, native gemini :embedContent + :batchEmbedContents
  + base64 packing (12 bytes = 3 floats), fallback chain 429→fallback
  attempts=2, anthropic-only 501 upstream_dialect_unsupported (logged),
  unknown model 404; the pre-existing M7 unknown-model check pinned to
  dialect 'chat' so it keeps asserting its own row)
- `npm run smoke:m8` — **43/43**; `npm run smoke:m9` — **75/75**;
  `npm run smoke:m10` — **33/33**; `npm run smoke:m11` — **ALL PASS (30)**
- Browser pass: not run — the UI delta is one Logs filter `<option>` + label
  map entry (typechecked + built; nothing visual beyond a dropdown entry).
- Live-provider verification: not run (no real embeddings-key provider
  configured; wire behavior pinned by goldens + the mock-upstream smoke
  checks incl. usage/cost math and both adapter URL shapes).

- **M12 — native Gemini adapter ✅ complete (session 18, 2026-09-19)** —
  "Let's go M12"; scope per ROADMAP.md's M12 row. Shipped:
  - **Third upstream adapter `gemini`** (`shared/adapters.ts` union widened;
    no schema change — `providers.adapters` already stores a JSON array).
    `adapters/gemini.ts` builds `POST {base}/models/{model}:generateContent`
    (streaming: `:streamGenerateContent?alt=sse` — the endpoint encodes
    streaming, the body has no `stream` field) with `x-goog-api-key` auth:
    system/developer messages fold into `systemInstruction`, user→user /
    assistant→model, consecutive same-role turns merged (tool results lead
    user turns), tool calls → `functionCall` parts with OBJECT args, tool
    results → `functionResponse` parts bound by tool NAME (resolved from the
    assistant turn's calls; Gemini has no call ids), images → `inlineData`
    (data URLs) / `fileData` (https), options → `generationConfig`
    (maxOutputTokens from either token field, stopSequences, topK from the
    `top_k` extra).
  - **Thinking budgets**: the openai-face `reasoning_effort` extra maps onto
    `generationConfig.thinkingConfig.thinkingBudget` (minimal→0 / low→1024 /
    medium→8192 / high→24576); a defensive `thinking.budget_tokens` extra is
    clamped to 0–32768. Thought-summary parts in responses are skipped (no
    `includeThoughts` requested); `thoughtsTokenCount` is ADDED to
    `candidatesTokenCount` for output billing (Google: total = prompt +
    thoughts + candidates — thinking bills as output).
  - **Response translation lives in `dialects/gemini.ts`** (new module, the
    gemini upstream vocabulary): `geminiCompletionToOpenAi` +
    `transformGeminiSseToOpenAi` normalize gemini JSON/SSE onto OPENAI chat
    shapes (functionCall → tool_calls with synthesized `call_gemini_<n>` ids
    and full-arguments deltas, finish_reason `tool_calls` when calls are
    present, `promptFeedback.blockReason` → content_filter finish), then the
    gateway serves EVERY client face through the existing openai-upstream
    paths (openai client = passthrough of the normalized body; anthropic/
    responses clients reuse their translators). `geminiErrorToOpenAi` maps
    the Google error envelope (status string → openai type, kept in `code`).
  - **URL rule**: `DEFAULT_BASES.gemini = …/v1beta`;
    `joinAdapterUrl` inserts `/v1beta` on bare origins (mirrors the openai
    rule), never touches pasted paths; `/v1`-strip is anthropic-only.
  - **Gateway**: `preferredAdapter` fallback is now the provider's FIRST
    declared adapter (behavior-identical for pure openai/anthropic providers;
    lets `[gemini, openai]` providers serve anthropic/responses clients
    natively). Assistant-first + n>1 throw `UnsupportedTranslationError`
    (same-candidate adapter retry / 400 untranslatable). 4xx + chain-
    exhausted gemini errors flow through a shared `upstreamErrorBody` helper.
  - **Admin**: test-connection probes `/v1beta/models` with `x-goog-api-key`
    (counts `models[]`); fetch-models normalizes the gemini listing (strips
    the `models/` prefix, `inputTokenLimit`/`outputTokenLimit` → context/out,
    skips non-`generateContent` entries like embeddings).
  - **UI**: Providers modal gains the `Gemini (native)` adapter checkbox,
    base-URL hint, and a `Gemini (native)` quick-fill preset (the
    `Gemini (OpenAI-compat)` preset stays — both registration paths work).
  - **No migration** (no schema change); no new route prefixes/bindings.
- **Next active milestone: M13 — embeddings** (per ROADMAP order).
- **MVP M1–M7 ✅**; **M8 ✅ (session 13)**; **M9 ✅ (session 14)**; **M10 ✅
  (session 15)**; **M11 ✅ (session 17)**.

## Verification baseline (2026-09-19, session 18)

- `npm run check` ×3 — clean (worker + web + test tsconfigs)
- `npm test` — **243/243** (+46: gemini request-build goldens ×19 incl.
  thinking/multipart/tool-name/untranslatable cases, gemini→openai JSON
  normalize + error-mapping goldens ×11, gemini SSE normalize goldens ×6,
  gemini usage extraction ×5, join-adapter-url gemini rules ×5)
- `npm run build:web` — clean (399.5 KB js / 109.7 KB gzip)
- `npm run migrate:local` — not re-run: **no migration in M12** (schema
  untouched; local D1 already at 0007_m11_cache)
- `npm run smoke` — admin API flow green (exit 0)
- `npm run smoke:gateway` — **159/159** (+21 M12 checks: test-connection +
  discovery for gemini, all three client dialects × JSON/SSE against a native
  gemini mock face (usageMetadata 4/8 with thoughts folded), tools round-trip
  (functionCall → tool_calls, tool result → functionResponse bound by name),
  inlineData vision, reasoning_effort → thinkingBudget 1024, Google 400/429
  error mapping in both envelopes, gemini log row with usage + exact
  $0.000072 cost at $2/$8 per 1M)
- `npm run smoke:m8` — **43/43**; `npm run smoke:m9` — **75/75**;
  `npm run smoke:m10` — **33/33**; `npm run smoke:m11` — **ALL PASS (30)**
- Browser pass (built bundle on :8787): login → Providers page (real
  kios-live-test provider untouched) → Add-provider modal renders the
  `Gemini (native)` checkbox + hint + quick-fill chip; chip fills
  `https://generativelanguage.googleapis.com/v1beta` and checks ONLY the
  gemini adapter. IAB locator clicks flaky as usual — drove links/modals via
  page-side events (known, not a product bug). Nothing saved (modal cancelled).
- Live-provider verification: not run (no real Gemini API key configured;
  wire behavior pinned by goldens + the mock-upstream smoke matrix).

- **M11 — semantic cache ✅ complete (session 17, 2026-09-19)** — "Let's go
  M11"; scope per ROADMAP.md's M11 row. Shipped:
  - **Storage: D1 table `cache_entries`** (not KV/DO): strongly consistent
    read-after-write so a repeat prompt deterministically hits (KV is
    eventually consistent → nondeterministic hits), admin flush/stats in SQL,
    TTL via lazy `expires_at` check + expired-row sweep in the same batch as
    each insert. Writes only happen on eligible misses (opt-in keeps the
    free-tier D1 budget safe). Migration `0007_m11_cache` (3 ALTERs +
    CREATE TABLE + 2 indexes, generated cleanly).
  - **Cache key** = sha-256 over a key-sorted stable JSON of
    `{v:1, model slug, messages, options, extras}` (canonical form —
    dialect-independent: one entry serves all three client faces;
    stream/streamIncludeUsage excluded). `v:1` rides inside the hashed payload
    to invalidate everything on a future canonical change.
  - **Entries store the RAW upstream JSON body + upstream adapter kind** +
    provider/upstream-model attribution; hits replay through the exact same
    `respondTranslated` path (same-dialect passthrough byte-identical,
    cross-dialect translated), so a hit is indistinguishable from a miss apart
    from `x-khateway-cache: HIT|MISS` (emitted only on eligible requests) and
    latency. Corrupt payload → falls through to the normal upstream path.
  - **Opt-in**: master `cache_enabled` setting (default 'off') AND
    (`models.cache_enabled` OR `api_keys.cache_enabled`); portal/org key DTOs
    read-only. **Eligibility** (text-only): no streaming, no tools/tool
    history, no images, n ≤ 1 (`cache/key.ts` gate, golden-pinned).
  - **Gates/billing order**: spend cap → rate limits → allow-list → balance
    gate → cache lookup → upstream. Hits still consume rate-limit budget, log
    `request_logs.cache_hit=1` with usage + EXACT priced cost from the stored
    payload (pricing follows the REQUESTED model; a fallback-produced entry
    debits the primary model's pricing — deliberate), and debit like any
    response. Store path: `Response.clone()` → waitUntil (skip ≥512 KB,
    non-JSON, or 200-with-`error`-body payloads) → INSERT + sweep in one batch.
  - **Admin/portal surfaces**: `GET /admin/cache` (entries/bytes/24 h hits/
    cached tokens), `POST /admin/cache/flush`, settings card (toggle + TTL +
    stats + Flush), Models + ApiKeys cache checkboxes, Logs "cached" badge,
    Overview "N cached" in the 24 h usage line.
- **Next active milestone: M12 — native Gemini adapter** (superseded the same
  day — see the top of this file).
- **MVP M1–M7 ✅**; **M8 ✅ (session 13)**; **M9 ✅ (session 14)**; **M10 ✅
  (session 15)**.

## Verification baseline (2026-09-19, session 17)

- `npm run check` ×3 — clean (worker + web + test tsconfigs)
- `npm test` — **197/197** (+17: cache-key projection goldens ×6 + key
  properties ×3 + eligibility gates ×8)
- `npm run build:web` — clean (399 KB js / 109.5 KB gzip)
- `npm run migrate:local` — `0007_m11_cache` applied (local D1)
- `npm run smoke` — admin API flow green (exit 0)
- `npm run smoke:gateway` — **138/138**
- `npm run smoke:m8` — **43/43**; `npm run smoke:m9` — **75/75**;
  `npm run smoke:m10` — **33/33**
- `npm run smoke:m11` — **ALL PASS (30 checks)** (new: call-counting mock
  upstream proves miss→store→hit with zero upstream calls; the same canonical
  request through /v1/messages and /v1/responses hits the openai-face entry;
  logs mark 1 miss + 3 hits with usage 12/7 + exact $0.00008 cost at $2/$8
  per 1M; streams/tools/non-opted models bypass; key-level opt-in caches a
  non-opted model and the cache is shared across keys; master-off bypasses;
  ttl=1s expiry; two flushes; 24 h stats)
- Browser pass (built bundle on :8787): login → Overview (user's real
  kios-live-test data untouched) → Settings (Semantic cache card: toggle,
  TTL 3600, live stats, Flush/Save disabled states) → toggle ON persisted
  ('on' via API) → toggled back off → Models register modal (Semantic cache
  checkbox) → API Keys modal (checkbox) → Logs renders. IAB locator clicks
  flaky as usual — drove links/modals via page-side events (known, not a
  product bug).
- Live-provider verification: not re-run (z.ai path unchanged by M11; last
  live e2e in sessions 6/11).

- **M10 — gateway rate limiting ✅ complete (session 15, 2026-09-18)** —
  "Let's go M10"; scope per ROADMAP.md's M10 row. Shipped:
  - **Design decision (roadmap deferred it to design time): Durable Object,
    not a D1 counter** — a D1 upsert would add one D1 write per gateway
    request (doubling write load; free-tier D1 budget is 100k writes/day and
    request_logs already spends it). `RateLimiterDO` is SQLite-backed
    (`new_sqlite_classes`, free-plan OK), singleton instance "global",
    fixed 1-minute windows in its storage SQL
    (`INSERT … ON CONFLICT … RETURNING count` — atomic, single-threaded DO),
    plain ES class + internal `POST /check` fetch protocol (no
    `cloudflare:workers` import → clean under tsc + vitest), amortized
    eviction every 50th call, fail-open client (`checkRateLimits` → null on
    any error — a limiter outage never bricks the gateway).
  - **Buckets** (one DO round-trip per request, `buildGatewayRateChecks`):
    per-key (`key:<id>`, deployment default or the key's `rate_limit_rpm`
    override) OR per-IP for anonymous (`ip:<cf-connecting-ip>` — keyed
    requests never touch the IP bucket) + optional global per-model
    (`model:<slug>`, `models.rate_limit_rpm`). Disabled flag → zero checks.
  - **429s**: dialect-correct envelope (openai `rate_limit_exceeded` /
    anthropic `rate_limit_error`) + integer `Retry-After`; the binding
    constraint (max count/limit) names the bucket. Logged like any outcome.
  - **Config**: settings rows `rate_limit_enabled` (default 'on'),
    `rate_limit_key_rpm` (120), `rate_limit_ip_rpm` (60) — cached with the
    enforcement flag (5 s TTL, one snapshot read); columns
    `models.rate_limit_rpm` + `api_keys.rate_limit_rpm` (null = unlimited /
    deployment default) — migration `0006_m10_rate_limits` (2 ALTERs).
  - **Admin/portal surfaces**: settings GET/PATCH + Rate-limiting card
    (toggle + two rpm fields), Models modal rate-limit field, ApiKeys modal
    override + table badge; portal/org key DTOs expose `rate_limit_rpm`
    read-only.
  - **Abuse controls**: signup/login rate limiting already existed (M8,
    per-isolate buckets — noted as adequate for now; captcha + key-scoped
    spend alerts DEFERRED, see MEMORY "M10 deferrals"). Done-when met:
    limits enforced under concurrent smoke (`npm run smoke:m10`, 33 checks —
    burst proofs per bucket, envelope/Retry-After in both dialects, disabled
    bypass, 429 log rows) and documented in README.
- **Next active milestone: M11 — semantic cache** (per ROADMAP order).
- **MVP M1–M7 ✅**; **M8 ✅ (session 13)**; **M9 orgs/teams ✅ (session 14)**.

## Verification baseline (2026-09-18, session 15)

- `npm run check` ×3 — clean (worker + web + test tsconfigs)
- `npm test` — **180/180** (+15: rate-limit builder goldens ×10 + DO
  fixed-window semantics ×5 against a fake SqlStorage, driving the REAL
  `RateLimiterDO.fetch`)
- `npm run build:web` — clean (394 KB js / 108 KB gzip)
- `npm run migrate:local` — `0006_m10_rate_limits` applied (local D1)
- `npm run smoke` — admin API flow green
- `npm run smoke:gateway` — **138/138** (+1: rate_limit_enabled=off setup
  check; suite disables M10 limiting because it bursts past the IP default)
- `npm run smoke:m8` — **43/43** (+1 setup check)
- `npm run smoke:m9` — **75/75** (+1 setup check)
- `npm run smoke:m10` — **33/33** (new: anonymous IP bucket, key bucket,
  per-key override, key independence, global model cap, Retry-After + both
  dialect envelopes, settings validation, disabled bypass after TTL wait,
  request_logs 429 attribution; fixtures self-cleaned, settings restored off)
- Browser pass (in-app browser, built bundle on :8787): login → Settings
  (rate-limiting card: toggle + 120/60 defaults + disabled Save) → Models
  register modal (Rate limit field) → API Keys create modal (Rate limit
  override field). No crashes; the user's real kios-live-test provider/models
  untouched. Caveat: IAB locator clicks flaky on this bundle — drove modals
  via page-side events; not a product bug (form submit + React handlers fine).
- Live-provider verification: not re-run (z.ai path unchanged by M10; last
  live e2e in sessions 6/11).

## Verification baseline (2026-09-18, session 13)

- `npm run check` ×3 — clean (worker + web + test tsconfigs)
- `npm test` — **163/163** (+14: password hashing roundtrip/format/cost ×5,
  LS webhook parse + credit math goldens ×9)
- `npm run build:web` — clean (362 KB js / 103 KB gzip)
- `npm run migrate:local` — `0004_m8_accounts_billing` applied (local D1)
- `npm run smoke` — admin API flow green (incl. settings GET/PATCH with the
  new `public_signup` field)
- `npm run smoke:gateway` — **137/137** (keyless matrix + enforcement
  regression re-verified after the M8 gateway changes)
- `npm run smoke:m8` — **42/42** (new; accounts/balance/ledger/webhook e2e
  vs `wrangler dev` + local mock upstream priced $2/$8 per 1M → exact 46 µ$
  debits assertable)
- Browser pass (in-app browser, built bundle on :8787): portal signup →
  dashboard ($0.00 + empty states) → key create + one-time reveal → admin
  login → Settings renders both toggles + billing form → Users page $2.50
  adjustment reflected with toast. Test user deleted afterwards.
- Live-provider verification: not re-run today (z.ai path unchanged by M8;
  last live e2e in sessions 6/11).
- **Keyless-native default ✅ shipped (session 11)** — khode (first external
  client) treats khateway as a keyless provider; the gateway now serves /v1
  anonymously by default. New `settings` table (migration `0003_settings`) +
  `client_key_enforcement` flag (`GET/PATCH /admin/settings`, TTL-cached 5 s
  per isolate — anonymous requests cost zero key-DB lookups). Default off: no
  auth header, the literal `anonymous` sentinel (Bearer or x-api-key — what
  khode sends keyless) and unknown tokens are all served anonymously; enrolled
  `khat-` keys still get spend caps/allow-lists/log attribution. Enforcement
  on: valid key required (khode users set `KHATEWAY_API_KEY`); anything else
  401s in the path's dialect. UI: enforcement toggle on the API Keys page.
  Also: `stream_options.include_usage` is now parsed/forwarded for openai-face
  streams (openai adapter re-emits it; anthropic→openai SSE translation emits
  a final usage-only chunk with `choices: []` when requested).
- **Multi-adapter providers ✅ shipped (session 10)** — `providers.adapter`
  scalar → `providers.adapters` JSON array (migration `0002_provider_adapters`
  backfills + drops the legacy column): dual-dialect endpoints (OpenRouter,
  LiteLLM, AI Gateway, …) are ONE provider with one shared base URL. Gateway
  picks the adapter per request (client-dialect match first; `/v1/responses` →
  openai) and retries the same provider through its other adapter when the
  first cannot express the request (n>1, assistant-first) before any fallback.
  `joinAdapterUrl` strips a trailing `/v1` for anthropic on shared bases. Admin
  API accepts `adapters` array (legacy `adapter` string coerced); DTOs expose
  both; Providers UI = adapter checkboxes; test-connection probes every
  declared adapter.
- **Audience amended (user): public platform** (was internal-only). **Active
  milestone: M8 — public foundations: accounts + MoR billing** — not started;
  shortlist Lemon Squeezy / Paddle / Polar (apply early — seller onboarding
  approval takes days). Recommended ops prerequisite first (small): real deploy
  — `npx wrangler d1 create khateway`, swap the placeholder `database_id` in
  `wrangler.jsonc`, set remote secrets, apply migrations remotely,
  `npm run deploy`.
- Local D1 **refreshed** (session 9, user-approved wipe): `.wrangler/state`
  removed + migrations re-applied — no legacy `raut-` keys, `rauter` log rows or
  stale sessions remain; all tables start empty (re-add providers/models in the
  console). Stale pre-rename `web-dist/` rebuilt. No dev server running; start
  one with `npm run dev`.

## Roadmap

Milestones live in **ROADMAP.md** (completed M1–M14 history, the post-MVP
order, done-when criteria, the public-platform/MoR billing context, the
real-deploy ops prerequisite and the unscheduled polish queue). Short version:
**MVP M1–M7 + M8 public foundations + M9 orgs/teams + M10 rate limiting + M11
semantic cache + M12 native Gemini adapter + M13 embeddings + M14 playground
UI ✅ complete**; the stated post-MVP order is exhausted — next work comes
from the unscheduled polish queue or user direction.

## Recent changes

- 2026-09-19 — **M15: pre-launch hardening + real deploy (session 21)**.
  Audit first (2 exploration passes + hand verification of the top findings),
  then: webhooks.ts rewritten atomic (webhook_events + ledger + balance in
  ONE batch, `isUniqueViolation` cause-chain discriminator — unique →
  duplicate 200, else 500 so LS retries); migration `0009_m15_log_indexes`
  (request_logs.api_key_idx — spend-cap SUM was a full scan per keyed
  request); portal keyUsage → SQL SUM+count; PATCH /users + /orgs validate
  balance BEFORE toggling enabled; root onError → generic 500 (HTTPException
  passthrough); README/App.tsx footer/UserRow drift fixes. **Real deploy:
  remote D1 `khateway` (32583a0a-…) wired into wrangler.jsonc, 10 migrations
  --remote, Worker live at https://khateway.chengsokdara.workers.dev,
  ENCRYPTION_KEY + ADMIN_PASSWORD secrets set (values piped, never
  displayed), deployed surface verified**. git init (main) + 2 commits.
  Tests: tests/worker/webhook-errors.test.ts (+4); all seven smokes re-green
  post-change. Contract in MEMORY.md → "M15 hardening + deploy contract".

- 2026-09-19 — **M14: playground UI (session 20)**. Migration
  `0008_m14_playground` (api_keys.playground_session — the owning admin
  session's sha256 token hash). Admin API: `POST /admin/playground/key`
  (rotate + mint a session-scoped key, sweep orphaned/expired-session
  playground keys via leftJoin), logout deletes the session's key,
  GET /admin/api-keys hides playground keys. Web: `pages/Playground.tsx`
  (model picker + temperature/max-tokens + system prompt + SSE streaming
  render with include_usage + Stop/Clear + log-row card polling
  api_key_id-filtered logs), nav entry after Models, `createPlaygroundKey()`
  with an inflight dedupe so React StrictMode's double-mount shares one key
  (mint = rotate — a second mint revokes the first). Gateway unchanged —
  playground keys are ordinary enrolled keys. Tests: `scripts/smoke_m14.mjs`
  (24 checks) + npm script. Verified: check ×3, vitest 266/266, build,
  migrate, all seven smokes (admin green, gateway 176, m8 43, m9 75, m10 33,
  m11 30, m14 24), live browser pass with a streamed mock round-trip +
  exact-cost log card. Contract in MEMORY.md → "M14 playground contract".

- 2026-09-19 — **M13: embeddings (session 19)**. New client face
  `POST /v1/embeddings` (OpenAI Embeddings API — the only embeddings client
  dialect): `dialects/openaiEmbeddings.ts` parse (input string|string[] →
  canonical `string[]`, pre-tokenized integer arrays rejected, dimensions/
  encoding_format validated, unknown fields → extras) + new
  `CanonicalEmbeddingsRequest` in canonical.ts. Adapters:
  `buildOpenAiEmbeddingsRequest` (POST {base}/embeddings, response relayed,
  JSON tee-watcher captures usage) + `buildGeminiEmbeddingsRequest`
  (:embedContent / :batchEmbedContents with embedContentConfig; dimensions →
  outputDimensionality, task_type/title extras → taskType/title).
  `geminiEmbeddingsToOpenAi` + `floatsToBase64` in dialects/gemini.ts
  normalize the gemini response (usageMetadata.promptTokenCount → usage +
  log tokens). Gateway: shared gates extracted (enforceSpendCap +
  enforcePostRoutingGates + makeWaitUntil — chat behavior byte-identical,
  all chat smokes re-green), embeddingsPipeline shares auth middleware/
  gates/fallback-chain/log-writer/debit; anthropic-only providers → 501
  upstream_dialect_unsupported; request_logs.dialect 'embeddings' (no
  migration); no semantic cache (chat-shaped eligibility gate, deliberate).
  Web: Logs filter option + label. Tests: embeddings-adapter.json +
  embeddings-openai.json + tests/worker/embeddings.test.ts (23 tests);
  smoke_gateway +17 M13 checks (mock /embeddings + gemini embeddings faces).
  Verified: check ×3, vitest 266/266, build, all six smokes (admin green,
  gateway 176, m8 43, m9 75, m10 33, m11 30). Contract in MEMORY.md →
  "M13 embeddings contract".

- 2026-09-19 — **M12: native Gemini adapter (session 18)**. Adapter union
  widened to `openai | anthropic | gemini` in shared/adapters.ts (worker env
  re-export + web api.ts Records + Providers.tsx ALL_ADAPTERS). New
  `adapters/gemini.ts` (canonical → generateContent/streamGenerateContent:
  systemInstruction folding, functionCall/functionResponse by tool name,
  inlineData/fileData multiparts, generationConfig + thinkingConfig from
  reasoning_effort/thinking extras, n>1 + assistant-first rejected) and
  `dialects/gemini.ts` (gemini→openai JSON/SSE normalizer — tool_calls with
  synthesized ids + finish_reason tool_calls, promptFeedback → content_filter,
  thoughts folded into completion tokens — plus geminiErrorToOpenAi).
  Gateway: UpstreamAdapter gains 'gemini', preferredAdapter falls back to the
  provider's first declared adapter, respondTranslated normalizes gemini →
  openai shapes then serves through the existing cells, upstreamErrorBody
  helper for 4xx + chain-exhausted paths. env.ts: DEFAULT_BASES.gemini +
  joinAdapterUrl bare-origin /v1beta insert. usage.ts: usageMetadata branches
  (json + sse watcher). cache: gemini entries stored/replayed via the
  normalize path. admin.ts: gemini test-connection + fetch-models branches.
  Web: ADAPTER_* records + Providers checkbox/hint + vendor preset. Tests:
  gemini-adapter.json + gemini-translation.json + gemini-sse.json +
  gemini.test.ts (+19 adapter cases, +11 json/error, +6 sse, +5 usage,
  +5 join-adapter-url); smoke_gateway gains the gemini mock face + 21 M12
  checks. Verified: check ×3, vitest 243/243, build, all six smokes (admin
  green, gateway 159, m8 43, m9 75, m10 33, m11 30), live browser pass on the
  Providers modal. Contract in MEMORY.md → "M12 native Gemini adapter
  contract".

- 2026-09-19 — **M11: semantic cache (session 17)**. Migration
  `0007_m11_cache` (models/api_keys.cache_enabled, request_logs.cache_hit,
  cache_entries + expires/model indexes). New worker module `cache/`:
  `key.ts` (stableStringify + cacheKeyInput + buildCacheKey sha-256 +
  evaluateCacheEligibility text-only gate) + `store.ts` (fail-open lookup,
  waitUntil store with sweep + payload guards, flush, snake_case stats).
  Settings snapshot extended (cache_enabled default off, cache_ttl_seconds
  default 3600). Gateway: cache block after all gates (spend cap/rate limits/
  allow-list/balance) before the chain walk — hits replay the stored raw
  upstream payload via respondTranslated with entry-truthful headers, misses
  clone + store under waitUntil; `x-khateway-cache: HIT|MISS` on eligible
  requests only; ChatMeta.cacheState + LogDraft.cacheHit. Admin: settings
  GET/PATCH + /admin/cache stats + /admin/cache/flush; models + api-keys
  cache_enabled fields; logDto cache_hit; overview usage_24h.cached.
  Portal/org key DTOs read-only. Web: Settings cache card, Models/ApiKeys
  checkboxes, Logs badge, Overview stat. Tests: cache-keys +
  cache-eligibility fixtures + tests/worker/cache.test.ts (17 tests);
  scripts/smoke_m11.mjs (30 checks) + npm script. Verified: check ×3, vitest
  197/197, build, migrate, all six smokes (admin green, gateway 138, m8 43,
  m9 75, m10 33, m11 30), live browser pass. Contract in MEMORY.md →
  "M11 semantic cache contract".

- 2026-09-18 — **vite dev proxy: /app/api + /webhooks (session 16)**. Portal
  signup/login from the hot-reload UI (:5173) returned "Request failed (HTTP
  404)" — the proxy added at M7 predates the portal and only forwarded
  /admin,/v1,/health, so POST /app/api/signup never reached wrangler. Added
  `/app/api` + `/webhooks` to vite.config.ts's proxy map (the /app pages
  themselves stay client-side in vite). Worker side verified fine (signup
  probe on :8787 → 201, probe row deleted after). No worker changes.

- 2026-09-18 — **M10: gateway rate limiting (session 15)**. New worker module
  `ratelimit/`: `do.ts` (`RateLimiterDO` — SQLite-backed fixed-window counters,
  `POST /check` internal protocol, fail-open on errors) + `client.ts`
  (`buildGatewayRateChecks` goldens + `checkRateLimits` fail-open DO client).
  wrangler.jsonc gained the `RATE_LIMITER` durable_objects binding +
  `new_sqlite_classes` migration (free-plan compatible); env.ts gained the
  binding type; index.ts exports the class. Migration `0006_m10_rate_limits`
  (models.rate_limit_rpm, api_keys.rate_limit_rpm). db/settings.ts refactored
  to one cached snapshot (enforcement + rate-limit settings, 5 s TTL,
  fail-open); admin settings GET/PATCH gained `rate_limit_enabled` /
  `rate_limit_key_rpm` / `rate_limit_ip_rpm`. Gateway: rate-limit check after
  model resolution — 429 + Retry-After in the caller's dialect, binding
  constraint named, logged like any outcome. Web: Settings rate-limiting card,
  Models modal field, ApiKeys modal + badge; portal/org key DTOs read-only
  field. Tests: `tests/fixtures/rate-limit-checks.json` +
  `tests/worker/rate-limit.test.ts` (builder goldens + real-DO-via-fake-SQL
  semantics); `scripts/smoke_m10.mjs` (33 checks) + npm script; gateway/m8/m9
  smokes disable limiting at setup (they burst past the IP default). Verified:
  check ×3, vitest 180/180, build, migrate, all five smokes (admin, gateway
  138, m8 43, m9 75, m10 33), live browser pass. Contract in MEMORY.md →
  "M10 rate limiting contract"; deferrals (captcha, spend alerts) in
  "M10 deferrals".

- 2026-09-18 — **M9: multi-user orgs / teams (session 14)**. Migration
  `0005_m9_orgs` (orgs, org_members, api_keys.org_id, request_logs.user_id/
  org_id, balance_entries.org_id + nullable user_id — drizzle-kit generated,
  data-preserving recreate inspected by hand). New worker module
  `routes/orgs.ts` (/app/api/orgs*: list/create/join/leave, detail with
  members + owner-only join_code, role changes + removals with last-owner
  guard, org keys CRUD with owner-any/member-own scoping, org usage, org
  billing + owner-only checkout). Gateway: org-balance gate + org debit in
  `debitBalanceUsage` (target = userId XOR orgId), request_logs attribution.
  Webhooks: `custom_data.org_id` credits the org (wins over user_id).
  Billing: `createLsCheckout` gained optional orgId. Admin: /admin/orgs
  list/patch/delete, delete-user org succession, api-key/log DTO attribution
  fields. Web: portal Teams page + nav, admin Organizations page + nav,
  portal-api/api clients extended. Rate limiter: `org-join:<userId>` bucket
  (20/min, per-user — smoke suites re-running within a minute no longer
  starve each other). smoke_m9.mjs: 74 checks. Verified: check ×3, vitest
  165/165, build, all four smokes (admin, gateway 137, m8 42, m9 74), live
  browser pass (fixed the EditOrgModal conditional-hook crash it caught).
  Full contract in MEMORY.md → "M9 orgs/teams contract".

- 2026-09-18 — **M8: portal accounts + prepaid balances + Lemon Squeezy MoR
  billing (session 13)**. New migration `0004_m8_accounts_billing` (users,
  user_sessions, balance_entries, webhook_events, api_keys.user_id — the
  generated migration was hand-trimmed of a no-op providers recreate caused
  by the hand-edited 0002 snapshot; schema.ts now declares
  `providers.adapters` last with `default('["openai"]')` so future generates
  stay clean). New worker modules: `billing/config.ts` (encrypted LS config
  in `settings`), `billing/lemonsqueezy.ts` (signature verify, payload
  parse/credit math, checkout builder), `routes/portal.ts` (/app/api:
  signup/login/logout/me, user keys, usage, billing + checkout),
  `routes/webhooks.ts` (/webhooks/lemonsqueezy, two-layer idempotent
  credit). Gateway: prepaid-balance gate + usage debit wired into the
  request-log writer. Admin: users CRUD + balance adjust, billing config,
  settings gained `public_signup`, api-keys DTOs gained user_id/user_email.
  Rate limiter bucketed (admin/portal-login/portal-signup 10/10/20 per min).
  Web: portal-api.ts + portal pages (login/dashboard/keys) + admin
  Users/Settings pages; App.tsx routes /app*. Tests: password + LS webhook
  vitest suites; `scripts/smoke_m8.mjs` (42 checks) + npm script. Verified:
  check ×3, vitest 163/163, build, migrate, smoke green, gateway smoke
  137/137, smoke:m8 42/42, live browser pass. Full contract in MEMORY.md →
  "M8 accounts + MoR billing contract".
- 2026-09-17 — **ROADMAP.md split (session 12, user ask)**: the "Upcoming
  milestones" roadmap section + the "Shipped — MVP recap (M1–M7)" section
  moved out of STATUS.md into a new dedicated **ROADMAP.md** (completed
  M1–M7 history, post-MVP order + public-platform/MoR context, M8–M14 table
  with done-when criteria, deploy prerequisite, unscheduled polish queue).
  STATUS.md keeps live state only and points there. No code change.
- 2026-09-17 — **Keyless-native gateway default (session 11, user ask: khode
  ships khateway as a keyless provider)**. `settings` table + drizzle migration
  `0003_settings` (hand-written + meta snapshot/journal); `db/settings.ts` with
  a 5 s isolate cache and fail-open read (DB hiccup → keyless, never brick the
  gateway); gateway auth middleware rewritten (anonymous sentinel short-
  circuits BEFORE any key-DB lookup; unknown keys ride anonymously when
  enforcement is off); `GET/PATCH /admin/settings`; enforcement toggle card on
  the API Keys page; request_logs.api_key_id = null for anonymous rows.
  Plus `stream_options.include_usage` end-to-end on the openai face (parse →
  canonical `streamIncludeUsage` → adapter re-emit; translated anthropic→openai
  streams emit the spec-shaped trailing usage-only chunk). Verified: check ×3,
  vitest **149/149**, build clean, admin smoke green, gateway smoke **137/137**
  (keyless + enforcement matrix, live `wrangler dev` + mock upstream).
- 2026-09-17 — **First external client: khode (the user's Go coding agent at
  `~/Apps/khode`) shipped khateway as a BUILT-IN provider** (khode commits
  662958b, e487bc9; khode-side work, no khateway code change needed). Khode
  speaks `GET /v1/models` + `/v1/chat/completions` (Bearer) and `/v1/messages`
  (`x-api-key`), picking its SDK client from the base-URL shape — the pinned
  M7 auth contract and the openai-shaped `/v1/models` listing are exactly
  what it consumes. **Live end-to-end verified** against `wrangler dev` + a
  local mock upstream: khode's real llm layer listed models, streamed a turn
  on the openai face (usage 12 in / 7 out) and cross-dialect on the
  anthropic face; both requests logged with usage + cost $0; fixtures fully
  cleaned after. Session-11 detail in MEMORY.md → "khode is khateway's
  first external client".
- 2026-09-17 — Session 10 (cont. 4): **bidirectional /v1 normalization** (user
  ask: accept base URLs with OR without /v1 and route correctly either way).
  `joinAdapterUrl` now also inserts `/v1` for openai paths when the base is a
  BARE ORIGIN (no path) — conservative on purpose: vendor bases with custom
  paths (z.ai `/api/coding/paas/v4`, Gemini-compat `/v1beta/openai`) never
  gain a `/v1`. The anthropic strip rule also covers origin+path bases
  (`/api/v1`, caught by new tests). Contract pinned by
  tests/worker/join-adapter-url.test.ts (11 cases incl. /models discovery
  paths); obsolete "Strip /v1" UI button + `looksLikeStrayV1` removed (both
  paste styles valid now — hint text updated). Smoke: new bare-origin dual
  provider proves both dialects → gateway smoke **125/125**; vitest
  **143/143**; check ×3 + build clean.
- 2026-09-17 — Session 10 (cont. 3): **vendor base-URL quick-fill** (user ask:
  make base URL entry easy, especially the anthropic-no-/v1 vs openai-/v1
  split). New dep-free shared module `src/shared/vendor-urls.ts` with curated
  presets (OpenAI, Anthropic, OpenRouter, LiteLLM, DeepSeek, Groq, xAI,
  Mistral, Together, Ollama, Gemini-compat, z.ai) + `looksLikeStrayV1`
  helper; `src/shared/adapters.ts` now owns the Adapter type (imported by
  worker + web — keeps tsconfig.web free of Workers types). Provider modal:
  "Quick fill" chips (dual-dialect vendors marked ×; chip sets URL + adapter
  checkboxes) and a smart "Strip /v1" button when an anthropic-only provider
  has a /v1 URL. Preset facts verified against vendor docs (OpenRouter
  /api/v1 serves BOTH /chat/completions and /messages; LiteLLM serves
  /v1/messages too). New tests/shared/vendor-urls.test.ts (8 tests) → vitest
  **135/135**; check ×3 clean, build clean, gateway smoke 123/123.
- 2026-09-17 — Session 10 (cont. 2): **upstream model discovery + import**
  (user ask: when adding a provider, fetch its model list and let the user
  pick models to import). New admin endpoints: `POST /admin/providers/fetch-models`
  (unsaved form probe — in-memory key only, never stored),
  `POST /admin/providers/:id/fetch-models` (saved provider, stored key),
  `POST /admin/providers/:id/import-models` (bulk create: slug = upstream id,
  dedupe + skip existing/bad slugs, cap 100/call). Provider modal: "Fetch
  models" button next to Base URL, scrollable checkbox picker (ctx window,
  display names, unsupported-name badges, select all/none), Import button —
  in add mode it auto-creates the provider then imports. Mock upstream
  extended with a richer /models fixture; +6 smoke checks → gateway smoke
  **123/123**. Verified: check ×3 clean, vitest 127/127, build clean.
- 2026-09-17 — Session 10 (cont.): **`npm run dev` is now the one-terminal
  hot-reload runner** (user request — default dev = wrangler + vite together).
  `scripts/dev-all.mjs` also builds the SPA once when `web-dist/` is missing
  (fresh-clone safety for the ASSETS binding). Script map: `dev:prod` = the
  old production-style dev (built bundle on :8787), `dev:all` = alias of
  `dev`, `dev:ui`/`dev:worker` unchanged. Verified: both ports up via
  `npm run dev`, first-run build kicks in, clean Ctrl-C, 0 orphans. Caveat
  learned: vite binds `localhost` (IPv6 ::1) — bare `curl 127.0.0.1:5173`
  refuses; the browser/proxy path is unaffected.
- 2026-09-17 — Session 10: **multi-adapter providers** (user ask: one provider
  row for vendors compatible with both adapters, future-proof for more).
  Schema `providers.adapter` → `providers.adapters` JSON array (hand-written
  migration `0002_provider_adapters`: ADD + backfill `json_array(adapter)` +
  DROP, snapshot/journal updated by hand — drizzle-kit generate needs a TTY
  for renames). Routing/gateway/admin/UI/smoke/tests updated; gateway retries
  the same provider via its second adapter on `UnsupportedTranslationError`
  (attempts counter now spans adapter retries + fallbacks). New golden
  fixtures for the shared-base URL rule. See "Current work state" for the
  contract.
- 2026-09-17 — Session 9: **rebrand Rauter → Khateway + moved out of the racode
  workspace to `~/Apps/khateway/`** (user request). Renamed everywhere: package
  name, worker name + D1 database name in `wrangler.jsonc` (placeholder
  `database_id` unchanged → local D1 data survived), admin cookie
  `khateway_session`, `x-khateway-*` response headers, client key prefix
  `raut-` → `khat-` (verification is a sha-256 lookup with no prefix check —
  pre-existing raw keys still work), synthetic IDs (`chatcmpl-khateway`,
  `resp_khateway`, `msg_khateway`), health `name`, UI labels/copy + `khateway:*`
  DOM events, smoke scripts (`.dev.vars` dev password kept in sync), fixtures +
  expected error copy, README/AGENTS/MEMORY/RULES/plan docs, package-lock.
  Verified: `npm run check` ×3 clean + vitest **125/125**, before and after the
  move. racode workspace AGENTS/RULES updated to drop the project. **Local D1
  then refreshed** (user-approved wipe): `.wrangler/state` wiped, migrations
  re-applied — stale `raut-` keys / `rauter` log rows / old sessions gone — and
  the stale pre-rename `web-dist/` rebuilt. Verified end-to-end on the fresh
  DB: `npm run smoke` green, `npm run smoke:gateway` **112/112**; post-smoke
  tables verified empty.
- 2026-09-17 — Session 8: STATUS rewritten for post-MVP phase (this document); full verification baseline re-run (check ×3, vitest 125/125, build, admin smoke, gateway smoke 112/112); AGENTS smoke-count touch-up (61 → 112); README milestones marked ✅; MEMORY deduped + session entry added. Roadmap section then recut (same session, user request) to the plan's post-MVP list in the user's order: billing → orgs → rate limiting → semantic cache → native Gemini → embeddings → playground (M8–M14); real deploy kept as the recommended ops prerequisite; prior hardening/canonical-extension items demoted to the unscheduled "also queued" list. **Then audience amended to PUBLIC (user decision)**: Stripe excluded (no Cambodia merchant support) → M8 reshaped to accounts + merchant-of-record billing (Lemon Squeezy first pick — Cambodia in its bank-payout list; Paddle/Polar fallbacks), M10 tagged public-launch blocker; recorded in MEMORY.md decisions + plan-doc amendment.
- 2026-09-16/17 (sessions 2–7) — M3: canonical pipeline (`canonical.ts`), routing with pinning + fallbacks (`routing.ts`), openai adapter, `/v1/chat/completions` + `/v1/models`. M4: anthropic adapter + `/v1/messages` + cross-dialect SSE. M5: `/v1/responses` + Responses events. M6: tools + vision + usage/stop-reason mapping + fallback retries. M7: client API keys (allowlists, spend caps), request logs with cost snapshots, logs + API keys UI, gateway smoke suite. Vitest golden-fixture suite added (7 files / 125 tests). Full history in `MEMORY.md`.
- 2026-09-16 — Session 1: plan approved (name **Khateway**), M1+M2 built (scaffold, auth with revocable sessions, providers/models CRUD, encrypted keys, test-connection, dashboard), docs trio + workspace docs created.

## Known issues

- None open at code level. Notes:
  - `npm run smoke:gateway`, `npm run smoke:m10` and `npm run smoke:m11`
    **clear all local request logs** (each exercises `DELETE /admin/logs`) and
    create/delete their own fixtures — run only on dev DBs. smoke_m11 also
    flushes the cache + restores cache settings to off at cleanup. `npm run smoke:m8` also **leaves its
    `webhook_events` rows** (per-run random order ids — kept as the audit
    trail). All burst-y smokes PATCH `rate_limit_enabled: 'off'` at setup;
    `smoke_m10` restores 'off' at cleanup too (neutral dev state).
  - `/admin` has no CSRF hardening (SameSite=Lax + HttpOnly, single origin). Fine internally; revisit if ever exposed publicly.
  - `wrangler 4.133.0` available (on 4.132.0) — informational, stack is frozen per RULES.md.
  - ~~Remote deploy prerequisites not yet done~~ **DONE (session 21)**:
    deployed to https://khateway.chengsokdara.workers.dev (remote D1 + secrets
    set). The remote DB starts EMPTY — register real providers/models in the
    deployed admin console; real Lemon Squeezy credentials still needed on
    admin Settings → Billing before top-ups work there.
  - Models with **null pricing cost portal users nothing** (unknown cost never debits) — set pricing before selling access to a model.
  - Portal accounts have **no email verification** (no email sender on Workers) — deliberate M8 deferral.
