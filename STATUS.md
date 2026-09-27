# STATUS.md — Khateway live status

Last updated: 2026-09-27 (whole-API free-tier flag + free-provider seeder DEPLOYED — version 518fc56f)

## How to use this file

Kept current **while working** (not just after tasks) so an interrupted session
can resume: check "Current work state" for what's in flight, "Roadmap" for
where the milestone plan lives, "Recent changes" for history (newest first).
If something is claimed ✅ but not verified, it says so.

## Current work state

- **Whole-API free-tier flag + free-provider seeder ✅ complete + DEPLOYED
  (2026-09-27)** — user committed the feature themselves (05bf120) after
  building on the free-models auto-sync; this session verified it live, found
  + fixed one bug it slipped past the first smoke pass, deployed, seeded.
  Shipped:
  - **Schema (migration 0014)**: `providers.free_tier` (boolean, default
    false) — whole-API free tiers (Groq, GitHub Models, Pollinations,
    Cerebras, SambaNova, Mistral, NVIDIA NIM: listings carry NO pricing and
    NO `:free` suffixes, yet every model is $0 rate-limited). When true the
    free-models sync imports the ENTIRE listing as free (pricing 0/0,
    sync-owned) — same accepted trade-off as the gemini rule. Detection
    order: `providerFreeTier || adapter==='gemini'` → free; else verified
    pricing zeros; else `:free` suffix. NEVER set on providers with real
    pricing (OpenRouter imports only its verified $0 entries).
  - **`npm run seed:free`** (`scripts/add-free-providers.mjs`): idempotent
    seeder for 9 researched free vendors (OpenRouter, Gemini AI Studio,
    Pollinations, GitHub Models, Groq, Cerebras, Mistral, SambaNova,
    NVIDIA NIM) — matches by NAME (existing rows PATCHed back in line:
    auto_sync/free_tier always, key only when the env var
    `OPENROUTER_API_KEY`/`GEMINI_API_KEY`/`GITHUB_TOKEN`/… provides one AND
    the row has none), then runs one sync. Flags: `--base`/`--password`/
    `--only`/`--no-sync`.
  - **UI/API**: Providers modal "Whole API is a free tier" switch + `free-tier`
    badge; providers CRUD accepts/echoes `free_tier`; 5 new vendor presets in
    `src/shared/vendor-urls.ts` (GitHub Models, Cerebras, SambaNova, NVIDIA
    NIM, Pollinations; Groq hint notes free tier).
  - **BUG FOUND + FIXED (bb5fc82)**: `GET /api/admin/providers` uses an
    explicit-column select (for the modelCount join) and `freeTier` was never
    added — the list API/UI always reported `free_tier: false` while the DB
    held the real value (PATCH/CREATE echoed correctly via all-column
    re-selects, which is why the first smoke pass and the create-echo check
    missed it; the seed script kept re-patching and flagged providers looked
    unflagged everywhere). Fixed the select + DTO mapping; new smoke check
    pins the LIST DTO. **Local DB had been silently correct all along** —
    NVIDIA's 82 / SambaNova's 7 imported wholesale in an earlier sync.
  - Verified: tsc clean; **375/375** offline tests (4 new free_tier goldens:
    flag wins over priced entries, pricing-less plain ids free, whole-listing
    select); **smoke_gateway 236/236** (4 new free_tier cells + 1 list-select
    pin); `npm run seed:free` exercised locally — 4/9 providers syncable
    keyless (OpenRouter, Pollinations, SambaNova, NVIDIA NIM; OpenRouter's
    listing is public, key only needed to CALL), 5 fail with clear "set its
    API key" hints until keys are set (Gemini 403; GitHub Models returns a
    shape discovery can't parse — revisit once a GITHUB_TOKEN is set; Groq/
    Cerebras/Mistral 401).
  - **DEPLOYED ✅ (2026-09-27, version 518fc56f-e9a9-4c3d-b576-e752cae6199b)**:
    migration 0014 was already applied remote (user ran it earlier; column
    verified via pragma), `npm run deploy` shipped the worker (assets
    unchanged — the SPA with the switch was already live). Live checks green:
    /health ok; /api/admin/providers + GET/POST /api/admin/models/sync → 401
    unauth; served bundle == local build (index-BgZBha-L.js).
  - **REMAINING (operator-only)**: set the vendors' API keys (env vars in the
    script header) and re-run `npm run seed:free -- --base
    https://khateway.chengsokdara.workers.dev --password '<admin>'` against
    prod so their catalogs import; remote currently has no auto_sync
    providers (first cron runs are no-ops until then).
- **Free-models auto-sync ✅ complete + DEPLOYED (2026-09-25)** — user:
  "update the models list on a regular basis … only
  import or update model that is free." Approved decisions: daily period,
  per-provider opt-in, auto-disable dropouts (sync-owned rows only), Gemini
  listings count as free-tier. Shipped:
  - **Schema (migration 0013)**: `providers.auto_sync` (boolean, default
    false) + `models.sync_source` (text; `'free_sync'` marks sync-owned rows).
  - **`src/worker/discovery.ts`** (new): `listUpstreamModelsForAdapter` +
    first-adapter `listUpstreamModels` lifted VERBATIM from admin.ts (admin
    faces unchanged) + NEW pricing capture — OpenRouter-style
    `pricing.prompt`/`pricing.completion` per-token strings → USD per 1M
    (`perTokenToPerMillion`; "0" → 0 = free, null = listing had no pricing).
    Both fetch-models routes + import-models now carry/land
    `pricing_input`/`pricing_output` (additive; import validation reuses the
    buildModelPatch bounds).
  - **`src/worker/models-sync.ts`** (new): pure halves golden-tested —
    `isFreeUpstreamModel` (gemini adapter → free; pricing present → free iff
    BOTH exactly 0; else `:free` id suffix — verified data beats naming),
    `selectSyncEntries` (per-adapter merge, dedupe on DERIVED slug),
    `syncSlugForId` (OpenRouter ids `vendor/model:free` contain `/` + `:` —
    both banned by the slug alphabet — so runs of banned chars collapse to
    `-`; the RAW id rides `upstream_model`), `planSyncUpserts` (creates
    priced 0/0 + sync-owned; metadata refreshes non-null-only; dropout
    disable + reappear re-enable for sync-owned rows ONLY; cross-provider +
    manual slugs skipped, never touched). `runModelsSync`: probes every
    declared adapter of every enabled auto_sync provider (per-provider
    try/catch, cap 200/provider, creates folded back for later providers'
    conflict checks), persists the JSON summary to settings
    `models_sync_last_run`.
  - **Wiring**: `export default { fetch: app.fetch, scheduled }` in index.ts
    (first cron handler in the repo); wrangler.jsonc `triggers.crons =
    ["17 3 * * *"]` (daily 03:17 UTC) + `/__scheduled` added to
    run_worker_first (otherwise the assets SPA fallback swallows the
    wrangler --test-scheduled route — found by smoke). Admin:
    `POST /api/admin/models/sync` (Sync-now button) + `GET …/models/sync`
    (last-run summary); providers CRUD accepts/echoes `auto_sync`.
  - **UI**: Providers modal "Auto-sync free models" switch + table badge;
    Models page "Sync free models" button + last-run line; fetch picker
    shows a `free` badge for 0/0 entries and the picker footnote mentions
    $0 pricing landing on import.
  - Verified: `npm run check` clean; **371**/371 offline tests (21 new:
    tests/fixtures/models-sync.json + tests/worker/models-sync.test.ts);
    **smoke_gateway 231 checks** (22 new — free-only import with derived
    slugs + manual-slug guard, pricing zeros, no-dup rerun, dropout disable,
    reappear re-enable, `/__scheduled?cron=17+3+*+*+*` → triggered_by=cron,
    GET last-run, auto_sync=false leaves the set); all other smokes green
    (smoke 45, m8 45, m9 75, m10 33, m11, m14, device, oauth ALL PASS).
  - Deploy note: the cron starts firing on its own after deploy (03:17 UTC
    daily); no auto_sync provider exists until toggled in the Providers UI,
    so early deploys are no-ops.
  - **DEPLOYED ✅ (2026-09-25, version aedbaffe-186b-4206-a4f9-6e8da55d3820)**:
    migration 0013 applied remote FIRST, then `npm run deploy` — wrangler
    registered the trigger (`schedule: 17 3 * * *`). Live checks green:
    /health ok; served bundle == local build (index-B3hC6bDe.js);
    GET /api/admin/models/sync + /api/admin/providers → 401 admin envelopes
    (new routes live). No provider has auto_sync on yet — the first cron run
    (03:17 UTC) is a no-op until the OpenRouter provider is toggled in the
    Providers UI.
- **Usage dashboard filters ✅ complete (2026-09-25, local only)** — user:
  "the admin usage page should have proper filters that make sense." Approved
  scope: the core four (Key · Model · Provider · Endpoint — user/org + status
  offered and declined). `GET /api/admin/usage` accepts `api_key_id` / `model`
  / `provider` / `dialect` (empty = unfiltered; unknown values match nothing,
  Logs-endpoint lax style) and threads them through ALL six queries — both
  windows included, so delta cards compare like-for-like. Page: filter bar
  card (four selects fed by the existing api-keys/models/providers endpoints
  + Reset) between header and stats; query key carries all filters;
  `placeholderData` keeps the previous view up while a filter switch
  refetches; no-match filters get their own empty state ("No requests match
  the current filters" + Reset filters) vs the unfiltered Playground nudge.
  Verified: check clean, 350 offline tests, smoke +1 filter check block
  (model filter narrows by_model to one entry, bogus dialect → 0 requests,
  key filter narrows by_key to that key) — ALL PASS; browser pass: endpoint
  filter narrowed stats 24→9 with charts redrawing, stacked no-match combo
  showed the empty state, Reset restored everything.
  **DEPLOYED ✅ (version 4fcc67c6)** — live checks green: /health ok; served
  bundle == local filter-bar build; `?dialect=zzz-bogus` → 0 requests while
  unfiltered returns real remote traffic (94 requests / 7 d, 4 models).
- **Admin usage dashboard ✅ complete (2026-09-24)** — user: "There should be a
  proper usage dashboard in the admin; it should have graph, chart, bars, etc."
  Approved plan: new `/admin/usage` page, hand-rolled SVG charts (no new deps),
  one new endpoint. Shipped:
  - **`GET /api/admin/usage?days=N`** (`routes/admin.ts`, after overview):
    everything aggregates in D1 over the existing `request_logs` (no schema
    change) — window + prev-window totals (requests, errors_4xx/5xx, tokens,
    cost, cache hits, avg latency), a zero-filled UTC time series, and top-10
    by-model / by-key (leftJoin api_keys) / by-dialect breakdowns.
    `days` clamps 1–90 (default 7); `days=1` → hourly buckets, else daily;
    the window is bucket-aligned with the CURRENT partial bucket last (exact
    days×24 / days buckets). First SQL time-bucketing in the codebase:
    `strftime` over `created_at/1000, unixepoch`; the codebase's first
    `groupBy(sql)` + `orderBy(desc(count()))` aggregates too.
  - **`components/charts.tsx`** (new): `StackedBarChart` (inline SVG,
    ResizeObserver width, nice-number y axis, auto-thinned x ticks, native
    `<title>` per-column tooltips), `HBars`, `Delta` (period-over-period
    badge, `inverse` for cost/errors/latency). Zero dependencies.
  - **`pages/Usage.tsx`** (new, nav "Usage" right after Overview, BarChart3
    icon, `/usage` legacy redirect): range selector (24h/7d/30d) + Refresh,
    6 delta stat cards, "Requests & errors" / "Spend (USD)" / "Tokens"
    charts, top-models table with mini bars, by-endpoint + top-keys HBars;
    60 s polling; empty state points at the Playground. Bucket labels UTC →
    rendered local.
  - Verified: `npm run check` clean; `npm test` 350/350;
    `scripts/smoke.mjs` +6 usage checks (unauth 401, clamp, exactly 24
    hourly / 7 daily buckets, zero-fill, totals ≥ seeded traffic, by_model
    membership) — ALL PASS; `smoke:gateway` 220/220 re-run after;
    browser-verified 7d + 24h views with seeded mock-upstream traffic
    (IAB full-page captures tile fixed sidebars — known capture artifact,
    not a page bug; clean 1440×2160 viewport capture used instead) + the
    empty state after clearing logs; traffic re-seeded afterwards.
  **DEPLOYED ✅ (version b9618f46)** — `npm run deploy` shipped worker + SPA.
    Live checks green: /health ok; / serves the new bundle
    (index--TPpWNxU.js); /api/admin/usage 401 unauth; logged-in fetch
    returns real remote aggregates (41 requests / 7 d, 3 models, khode
    keys); the live /admin/usage page browser-verified rendering every
    panel with production data.

- **P-pack: cache_control passthrough + DO login buckets + fallback backoff +
  spend-cap reservations ✅ complete (sessions 30, 2026-09-24)** — user picked
  ALL FOUR queued polish items. Four commits, each with offline goldens + smoke
  cells, full sweep green between items:
  - **P1 cache_control passthrough** (`69c0d83`): canonical
    `CanonicalCacheControl` + message/tool-def fields (block markers fold to
    message level, last-wins); anthropic parser lifts them from system blocks /
    content blocks / tool_result / tool defs (invalid type/ttl → 400);
    anthropic adapter re-emits (marked system → block array, text-or-last
    block, tool_result, tool defs); openai/gemini drop them; cache keys include
    cacheControl only when present; anthropic `supported_parameters` + 'cache_control'.
    Tests: +5 goldens, +7 gateway smoke cells (216→...).
  - **P2 login buckets → DO** (`1032263`): `loginAllowed` moved to
    ratelimit/client.ts — async, env-scoped, one DO `/check` per attempt
    (`login:<bucket>:<ip>`), fail-open. All 9 call sites (admin, portal
    login/signup, oauth start/callback, device code/token, client-api,
    org-join) awaited. Per-isolate Map deleted.
  - **P3 fallback backoff** (`8c9aea7`): new `backoff.ts` — a 429/5xx retries
    the SAME upstream once after a budgeted wait (upstream Retry-After honored
    ≤ 4 s cap, else exponential 250/500 ms; ≤ 8 s total/request; Retry-After
    beyond cap → fall through at once; timeout/network never same-retry);
    chain-exhausted 429 relays upstream `retry-after`; both chat + embeddings
    loops. Fallback smoke expectations updated (retried chains report higher
    attempts); +1 golden file (11 cases).
  - **P4 spend-cap reservations** (`95dd4cd`): DO `/reserve` + `/settle`
    (reservations table, 5-min TTL sweep); capped keys park a chars/4-input +
    capped-output estimate (USD-per-1M pricing) post-routing; refuse 429 when
    `D1 SUM + in-flight ≥ limit` (release-before-refuse); `writeRequestLog`
    settles after the log row / final stream usage. Fail-open when DO down.
    New gateway smoke: two concurrent capped-key requests → exactly one 429.
  Verified per item: `npm run check` clean; npm test 326→**350**; smoke:gateway
  216→**220**; smoke 33, m8 45, m9 75, m10 33, m11/m14/device/oauth ALL PASS.
  DEPLOYED ✅ post-pack (see below).
- **Social sign-in (Google + GitHub) on the portal ✅ complete (2026-09-24)** —
  user: khode's device sign-in should get a one-click browser step; a
  first-time user must not be forced to create an email/password account
  just to approve a device code. Shipped exactly to the approved design:
  pure OAuth 2.0 authorization-code flow on fetch (no SDKs) —
  `routes/oauth.ts` (`/:provider/start` + `/:provider/callback`, mounted at
  `/api/portal/oauth` BEFORE portalApp so the portalAuth catch-all can't
  swallow the anonymous routes), state = random 32B hex + HttpOnly
  SameSite=Lax 10-min cookie binding {random, provider, next}; credentials
  in `settings` rows (billing/config.ts pattern, migration 0012) surfaced at
  `GET/PATCH /api/admin/settings/oauth` + the admin Settings "Social
  sign-in" card (copyable callback URLs, secrets hint-only). Link-or-create
  is the pure `decideOAuthSignIn` in `db/oauth.ts` (offline-tested):
  identity row → sign in; provider-VERIFIED email match → link; else create
  (public_signup permitting); unverified email NEVER links and an email
  conflict refuses instead of linking. `users.password_hash` is now NULLABLE
  — OAuth-only accounts get 401 "This account signs in with Google/GitHub —
  use the buttons above." on password login. PortalLogin: social buttons +
  "or continue with email" divider + `?error=` surfaced inline; `?next=`
  mechanics untouched — the device round-trip survives (khode needs zero
  changes). Plus one portal-shell fix the feature exposed: App.tsx's 401
  guard no longer re-navigates when already on /app/login (a background
  me() 401 fires there on every mount and was burying ?error=/?next= inside
  a nested next= that PortalLogin rejects — this also repairs the plain
  device-link SPA round-trip). Verified: `npm run check` clean; `npm test`
  326 offline tests green (22 new: decision + state cookie + normalizers +
  authorize URLs); NEW `scripts/smoke_oauth.mjs` 14 checks (unconfigured/
  unknown provider + no-state callback → error redirects, never 401 — mount
  order proven; fake google creds → authorize 302 with state cookie;
  mismatched state / garbage code / replay → error; next preserved; rows
  restored); ALL suites green vs dev: smoke, gateway 209, device 21, m8 45,
  m9 75, m10 33, m11, m14; browser-verified login page (buttons, divider,
  ?error= persists) + admin Social card (save flow flips configured +
  secret hint); real Google/GitHub round-trip = manual, steps in README.
  **DEPLOYED ✅ (2026-09-24, version 0d9a6a75)** — remote D1 already had
  migrations 0011+0012 applied (`device_codes` + `oauth_identities` tables
  verified); `npm run deploy` shipped the worker. Live checks all green:
  /health ok; / + /app/login serve the new SPA (bundle contains the social
  buttons); keyless /v1/models → 401 (strict keys intact);
  /api/portal/oauth/google/start → 302
  `/app/login?error=Google+sign-in+is+not+configured+on+this+instance.`
  (failure-redirect contract live, never 401/JSON); POST /api/v1/device/code
  mints a real code (device flow + table live; test row deleted after).
  REMAINING (operator-only): create the real Google + GitHub OAuth clients
  and paste them into the remote admin console (Settings → Social sign-in;
  callbacks https://khateway.chengsokdara.workers.dev/api/portal/oauth/
  {google|github}/callback), then walk the README manual round-trip once.
- **Keyless removed — keys required, always ✅ complete (session 29,
  2026-09-24)** — user: with device sign-in shipped, keyless makes no sense.
  REMOVED together: the keyless-native default + `client_key_enforcement`
  setting, the official-build keyless gate (`keyless_gate_secret_hash` +
  `x-khateway-access`), and the guest pool (`keyless_guest_user_id`). The
  auth middleware is now unconditionally strict: no header, the old
  `anonymous` sentinel, unknown and disabled tokens all get 401
  `invalid_api_key` in the path's dialect. Settings API/UI show only
  public_signup + rate limits + cache (old settings rows are ignored
  orphans, no migration). Onboarding = device flow (/api/v1/device) or
  portal/admin keys. Verified: check clean, 304 offline tests, smoke
  suites re-anchored to strict auth (gateway 209, m10 33, m8 45, m9 75,
  m11/m14/device/smoke green). Deployed + verified live: keyless /v1 → 401
  remotely. khode-side removal ✅ also landed (khode 2026-09-24, verified:
  `config.KeyOptional` deleted, `khatewayAnonKey`/`khatewayAccessSecret`/
  `x-khateway-access` threading removed, device sign-in or a real key
  required; build/vet/test green, committed).
- **Device-flow onboarding + guest-pool debit ✅ complete (session 28,
  2026-09-24)** — user: khode exists to be used by OTHER people; the earlier
  "only people you gave builds to" framing was wrong. Shipped the two
  recommendations: (1) **RFC 8628 device flow** — khode `/login` mints at
  `POST /api/v1/device/code`, the user approves at `/app/device` (portal
  session binds the request to their account), `POST /api/v1/device/token`
  grants a one-shot PERSONAL khat- key (ordinary portal key: visible,
  revocable, balance-gated, attributed). device_code hashed at rest;
  user_code XXXX-XXXX unique-forever; guarded consume-before-mint. Portal
  login now preserves `?next=` so verification links survive the round-trip.
  (2) **Guest pool** — settings `keyless_guest_user_id` (admin Settings
  card, `keyless_guest_email` PATCH validated against portal accounts):
  keyless requests resolve the pool account in the middleware, inherit its
  id into every LogDraft (attribution + debits ride the existing path), and
  balance-gate at $0 with a pool-exhausted 429. The pool balance is the
  operator's TOTAL keyless exposure. Verified: check clean, 304 offline
  tests, smoke_gateway 242 (12 new guest-pool checks), NEW smoke_device 21
  checks, m8/m9/m10/m11/m14 all green; khode build/vet/test/gofmt green +
  live probe of the dev server through the new client. NOT deployed.
- **Keyless gate: official-khode-build attestation ✅ complete (session 27,
  2026-09-24)** — user: keyless usage must only be reachable from khode
  builds THEY built; repo builds (e.g. post-open-source) must not. Gate is
  OPT-IN via a settings secret (off = today's behavior): admin sets
  `keyless_gate_secret` (16–256 chars; admin Settings card or PATCH) → only
  its sha-256 is stored (`keyless_gate_secret_hash`) → keyless /v1 requests
  need `x-khateway-access: <secret>` else 401 `unauthorized_client` (path
  dialect). khode: `scripts/build-release.sh` bakes `KHODE_ACCESS_SECRET`
  via ldflags into `internal/llm.khatewayAccessSecret` and every khateway
  request (both faces + FetchModels) carries the header; plain `go build`
  = no header = 401 on a gated gateway (works with `KHATEWAY_API_KEY`).
  Enrolled keys unaffected; enforcement-on unaffected; settings fail-open
  keeps gate-off (safe — no D1, no models). Verified: check + 304 offline
  tests + all 6 smoke suites, smoke_gateway now 230 checks (14 new).
  Boundary: can't stop extraction of the secret from an official binary
  (inherent to embedded credentials). NOT yet deployed — `npm run deploy`
  when ready, then set the secret in the remote admin console.
- **Landing page: admin links removed ✅ complete (session 26, 2026-09-24)**
  — user: admin is operator-only, why is it prominent on the public landing.
  `pages/Landing.tsx` dropped all three /admin touchpoints: header emerald
  "Admin console" button (Portal promoted to the emerald header button in its
  place), hero "Admin sign in" secondary CTA, footer "Admin" link. Portal is
  now the only linked surface. `/admin/login` is still reachable by URL/
  bookmark (password + 10/min login bucket unchanged). Header comment
  documents the deliberate unlinking. No worker/gateway changes; AGENTS map
  unchanged.
- **Fetch/import models moved to the Models page ✅ complete (session 25,
  2026-09-23)** — user: "move fetch model and import model to the model page
  … improve the ui of adding model with just fetch from the provided provider
  base url, and give options to add custom model when provider doesn't have
  /models". Shipped:
  - **Models page "Add models" modal** (`pages/Models.tsx`): segmented control
    with two tabs — **"Fetch from provider" (default)**: provider select
    (pre-seeded from the page's provider filter) → Fetch models → scrollable
    picker (filter box, select/deselect shown, "already added" badges for
    slugs registered under ANY provider, "unsupported name" badges, 100-cap
    guard) → Import (footer CTA). **"Custom model" tab**: the original manual
    register form, for providers without a /models endpoint. A failed fetch
    shows a "Provider has no /models endpoint? Add it manually instead →"
    nudge that switches tabs. Edit stays on the unchanged edit modal (same
    component, `initial != null` renders no tabs).
  - **Providers modal stripped** (`pages/Providers.tsx`): fetch/import state,
    handlers, picker and the Base-URL "Fetch models" button removed — the
    provider modal is pure CRUD/presets again. `fetchModelsPreview` (unsaved
    variant) removed from api.ts; the endpoint stays.
  - **Enriched import** (`routes/admin.ts`): `POST
    /providers/:id/import-models` now ALSO accepts
    `{models: [{id, display_name?, context_window?, max_output_tokens?}]}` —
    the picker's fetch results land with display names + token limits filled
    (legacy `model_ids` body still works; both → 400, bad enrichment → 400,
    slug/dup rules unchanged). api.ts `importModels(id, models)` sends it.
  - **Discovery default-base fallback** (`listUpstreamModels`): a provider
    with no stored base_url now probes `DEFAULT_BASES[adapter]` (same
    fallback the connection test uses) instead of failing "No base URL
    configured".
  - **vite dev proxy fix** (user's uncommitted WIP bug): `/api` prefix
    matched the app's own `/api.ts` module (root is `src/web`) and proxied it
    to the worker → every page blank under `npm run dev:ui`/`dev`. Key is now
    the regex `'^/api/'`.
  - Tests: smoke_gateway +4 checks → **216** (enriched import lands
    metadata, entry dedupe + collision skip, both-bodies 400, bad enrichment
    400). Verified: tsc ×3 clean, vitest 304/304, smoke_gateway 216/216,
    browser pass on the new modal (fetch real upstream, filter, select
    logic, import 2 + toast + table refresh, re-fetch "already added",
    custom-tab register, provider modal clean). Test fixtures (2 imports + 1
    custom model + temp OpenRouter provider) deleted after.
- **fetch-models: OpenRouter max-completion-tokens ✅ complete (session 24,
  2026-09-23)** — user asked whether `context_window` / `max_output_tokens`
  still make sense on the add-model form. Answer: keep both — `max_output_tokens`
  is load-bearing (the anthropic adapter synthesizes the API-required
  `max_tokens` from it when the client omits it; null → blanket 4096, which
  silently truncates modern Claude output), `context_window` is unenforced
  `/v1/models` metadata (OpenRouter-parity; client apps read `context_length`).
  Shipped: the openai-shaped `/models` discovery branch falls back to
  `top_provider.max_completion_tokens` for `max_output_tokens`
  (`routes/admin.ts`) — OpenRouter nests the cap there, so imported models
  on such providers land with a real output cap (Anthropic + plain-OpenAI
  listings expose no limits; those stay null → 4096 default still applies).
  smoke_gateway: `mock-chat` fixture now carries the OpenRouter shape + a
  new normalization check (211 → 212). Verified: tsc ×3 clean, vitest
  304/304, smoke_gateway 212/212 against `npm run dev`.
- **Model form: token-limits fields collapsed ✅ complete (session 24,
  2026-09-23)** — follow-up to the above: `context_window` /
  `max_output_tokens` moved into a collapsed "Token limits" section
  (same toggle pattern as the existing Advanced block) placed DIRECTLY
  ABOVE it — final form order: identity → pricing → rate limit → cache →
  capabilities → Token limits (collapsed) → Advanced (collapsed) →
  Enabled; labelled "optional — auto-filled by Fetch models"; hints now say
  what each feeds (`/v1/models` metadata, not enforced; anthropic default
  `max_tokens` when the client omits it, else 4096). Auto-expands when
  editing a model that already has either value. Payload/logic untouched.
  Verified: tsc ×3 + `vite build` clean.
- **Deployed ✅ (session 24, 2026-09-23)** — shipped sessions 23+24 to
  https://khateway.chengsokdara.workers.dev (version `1e94206a`). Caught
  pre-deploy: **migration `0010_m16_attribution` was still pending on the
  remote D1** (prior M16-M18 deploys never applied it — remote request-log
  rows could not have carried http_referer/x_title) — applied, then
  `npm run deploy`. Live checks: `/health` ok; `/` + `/admin/login` serve
  the new SPA bundle; `/v1/models` answers keyless with the registered
  provider's models; `/api/admin/*` 401s unauthenticated (new mount).

- **Routing restructure + public landing page ✅ complete (session 23,
  2026-09-23)** — user: "Move admin pages to /admin and leave the / for
  landing page" then "api should be live inside /api so that /app and /admin
  is for pages". Shipped:
  - **All management APIs under `/api`**: admin console API `/admin/*` →
    **`/api/admin/*`**; portal + orgs API `/app/api/*` → **`/api/portal/*`**.
    `/api/v1` (client key/credit API) already fit. Mounts changed in
    index.ts only (route files are relative internally); web clients
    (api.ts, portal-api.ts) + all seven smoke scripts renamed. `/v1` gateway
    and `/webhooks/lemonsqueezy` UNTOUCHED (SDK surface + externally
    configured LS callback URL).
  - **`/admin` + `/app` are now pure page prefixes**: `/admin/*` dropped from
    `run_worker_first` — admin console pages (moved from root paths) are
    served by the assets layer's SPA fallback exactly like `/app` pages. New
    `run_worker_first`: `/v1(/*)`, `/api(/*)`, `/webhooks(/*)`, `/health`.
    No content-negotiation middleware needed. Session cookies are `path: '/'`
    (verified) — auth unaffected.
  - **Public landing page at `/`** (`pages/Landing.tsx`): product hero
    ("One base URL for every model") + 6-feature grid + Portal/Admin CTAs,
    dark zinc + emerald. `/` previously rendered Overview.
  - **App.tsx routes moved under `/admin`** (NAV + route chain + all page
    links Overview/Models/Playground/Login); 401 + logout → `/admin/login`;
    login success → `/admin`. Legacy root bookmarks client-redirect via a
    LEGACY_ROUTES map + new `replace()` in router.tsx (history-replace, no
    back-button loop): `/overview`→`/admin`, `/providers`→`/admin/providers`,
    …, `/login`→`/admin/login`.
  - **vite.config proxy**: `/admin` + `/app/api` keys → single `/api` key;
    admin/portal pages ride vite's SPA fallback in dev (hot reload intact —
    verified via :5174 curls; note vite binds localhost/::1, not 127.0.0.1).
  - Tests: no new vitest (path plumbing only; 304/304 unchanged). smoke.mjs
    +2 static-serving checks (GET / → 200 html, GET /admin/overview → 200
    html SPA fallback). Browser pass: landing renders (screenshot), login →
    `/admin` Overview with live data, legacy `/providers` → `/admin/providers`
    redirect, `/app` portal intact.
- **M18 — structured outputs / JSON mode ✅ complete (session 22,
  2026-09-21)** — the last package in the approved M15→M18 sequence. Shipped:
  - **Canonical** `CanonicalResponseFormat` ({type:'json_object'} |
    {type:'json_schema', name?, schema?, strict?}) + `responseFormat?` on the
    request. Shared validator `responseFormatOption(v, param, shape)` in
    dialects/options.ts reads both wire shapes (openai chat nested
    `json_schema` object; responses flat + `{type:'text'}` passthrough).
  - **Parsers**: openai chat `response_format` and responses `text.format`
    parse onto canonical (unknown type → explicit 400; no longer riding
    extras — the openai adapter re-emits explicitly, so openai→openai wire
    behavior is unchanged while translated paths gain the feature).
  - **Adapters**: openai re-emits verbatim; gemini →
    `generationConfig.responseMimeType:'application/json'` +
    `responseSchema` (recursive cleaner keeps only the OpenAPI-subset keys
    Gemini honors — type lowercased, $schema/additionalProperties/… dropped);
    anthropic → best-effort system JSON directive (json_schema embeds the
    schema; documented NOT a hard guarantee — the upgrade path is
    single-tool emulation, deliberately not built; MEMORY contract).
  - **Cache keys**: `reasoning` (M17 catch-up) + `responseFormat` ride
    cacheKeyInput ONLY when present — spread, not unconditional null fields —
    so pre-M17 cache entries stay valid.
  - **/v1/models supported_parameters** gains 'response_format' on the
    anthropic + gemini adapter lists.
  - Tests: +8 vitest → **304** (parse ×4, adapters ×3, cache-key projection);
    smoke_gateway +5 M18 cells → **211** (verbatim re-emit, anthropic
    directive, gemini schema cleaning, responses text.format, invalid 400).
- **M17 — reasoning/thinking end-to-end ✅ complete (session 22, 2026-09-21)**
  (user: "continue" — M17 was next in the approved sequence). Shipped:
  - **Canonical**: `CanonicalReasoning` ({effort?, budgetTokens?}) on the
    request + `CanonicalReasoningContent` ({text?, signature?, redacted?}) on
    messages (canonical.ts). Shared helpers in `dialects/options.ts`
    (EFFORT_BUDGETS minimal 0 / low 1024 / medium 8192 / high 24576,
    reasoningEffortOption, canonicalReasoning, canonicalReasoningContent).
  - **Client faces un-rejected**: openai chat `reasoning_effort` promoted from
    extras; `reasoning_content` message field parses into history; anthropic
    `thinking` param ({enabled,budget_tokens}|{disabled}) + thinking/
    redacted_thinking blocks (signature preserved verbatim); responses
    `reasoning` param (effort) + reasoning input items (summary_text folded).
  - **Adapters**: anthropic emits `thinking:{type:'enabled',budget_tokens}`
    (explicit budget wins over effort; clamped to max_tokens-1; DROPPED when
    no room for the ≥1024 floor — request still succeeds; temperature/top_p
    suppressed while thinking is on); thinking blocks LEAD assistant turns
    (redacted → redacted_thinking). gemini thinkingConfig from canonical
    reasoning (+ includeThoughts:true when budget > 0); openai re-emits
    `reasoning_effort` (budgets are gateway-only); openai/gemini histories
    DROP reasoning (never needed to continue).
  - **Translation (the matrix)**: anthropic thinking/thinking_delta ↔ openai
    `reasoning_content` (JSON + SSE, DeepSeek/GLM convention) ↔ responses
    reasoning output items + `response.reasoning_summary_{text,part}.*`
    events (lazy-opened BEFORE the message item, finalized before it);
    gemini thought parts surface as reasoning_content → anthropic thinking
    blocks → responses reasoning items. `anthropicMessageToOpenAiCompletion`
    folds thinking into reasoning_content (redacted dropped); both Responses
    JSON translators emit a leading `rs_*` reasoning item.
  - **Billing unchanged**: anthropic counts thinking in output_tokens; gemini
    thoughts already fold into output (M12 contract).
  - **Tests**: +12 vitest (296 total; parse/adapter/JSON/SSE goldens incl.
    thinking-param parse, budget clamp + no-room drop, signature round-trip,
    reasoning_content ↔ thinking SSE both ways, responses reasoning item
    sequence); smoke_gateway +16 M17 checks → **206** (mock faces
    `claude-think` + `gem-think`: param in/out, history re-emission,
    effort→budget in all 3 faces, thought surfacing in all 3 faces, history
    dropped for gemini).
- **Next: none scheduled — the approved M15→M18 sequence is COMPLETE.**
  Remaining polish lives in ROADMAP.md ("Also queued") + the M17 contract's
  deliberate cuts (anthropic json_schema tool emulation, client provider
  routing prefs, prompt-cache_control passthrough).
- **M16 — OpenRouter client-parity pack ✅ complete (session 21, 2026-09-19)**
  (after M15 hardening + real deploy, same session). Shipped:
  - **`GET /v1/models` enrichment** (additive DTO): `pricing` as OpenRouter-
    style per-token decimal strings derived from USD-per-1M (`usdPerMillionTo
    PerToken` — toFixed(12) + trim so 1.5e-7 never renders as exponent; null
    when unset — unknown ≠ free), plus `supported_parameters` derived from the
    provider's declared adapters (what the gateway can express end-to-end).
  - **Client `/api/v1` endpoints** (`routes/clientapi.ts`, mounted at
    `/api/v1`; run_worker_first + vite proxy updated): `GET /auth/key` +
    `/key` (key info: label/limit/usage/limit_remaining/is_disabled) and
    `GET /credits` (user key → user balance, org key → org balance, admin key
    → 404 `no_balance`; account-wide usage + per-key usage). A client API key
    IS the credential here (Bearer or x-api-key) — anonymous/`anonymous`
    calls 401 even under the keyless default. In-memory `client-api` bucket
    60/min/IP (login-limiter pattern; DO migration stays queued).
  - **Legacy `POST /v1/completions`** (`dialects/openaiCompletions.ts`):
    prompt → canonical user message; rides the FULL chat pipeline via a
    `preParsed` passthrough into `chatPipeline` (gates/fallbacks/cache/log/
    debit identical); responses REWRITTEN chat→`text_completion` (JSON +
    SSE; never raw passthrough). `request_logs.dialect='completions'`;
    prompt arrays (n>1) and echo/suffix/best_of/logprobs/logit_bias rejected
    explicitly; penalties ride extras; missing [DONE] synthesized, doubles
    prevented.
  - **Attribution**: `HTTP-Referer` + `X-Title` read on /v1, persisted
    (migration `0010_m16_attribution`: request_logs.http_referer/x_title,
    applied local), exposed in admin logDto + Logs UI key cell (X-Title, else
    referer host). Never auth headers; length-capped.
  - **Success-path `x-ratelimit-limit/remaining/reset-requests`** headers
    from the BINDING rate-limit bucket on every /v1 response when limiting
    ran (the DO decisions already carried count/limit/reset — no protocol
    change); 429s keep retry-after only.
  - **`usage: {include: true}`** (OpenRouter accounting param) parsed onto
    canonical `streamIncludeUsage` and stripped from extras (never 400s
    upstreams).
  - **SSE keep-alives**: `withSseKeepAlive` injects `: keep-alive` comments
    during silence (backpressure-safe timer racing reads) on every translated
    stream + the passthrough SSE branch + the completions output; comments
    never break the usage watchers (parser skips them).
  - Tests: +14 vitest (parse/JSON/SSE goldens + keep-alive timing) → 284;
    smoke_gateway +14 M16 checks → 190; smoke_m10 +4 header checks → 37;
    smoke_m8 +2 /api/v1 checks → 45.
- **Next: M17 — reasoning/thinking end-to-end** (per the user's chosen
  sequence), then M18 structured outputs.
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

## Verification baseline (2026-09-23, session 23)

- `npm run check` — clean (worker + web + test tsconfigs)
- `npm test` — **304/304** (no new unit tests; path plumbing only)
- `npm run build:web` — clean (415.1 KB js / 114.0 KB gzip, + landing page)
- curl on `wrangler dev` :8787: `/`, `/admin`, `/admin/overview`, `/providers`
  (legacy) all 200 text/html; `/api/admin/overview` unauth 401 JSON; bad
  login 401; `/api/portal/me` unauth 401
- Smokes: `node scripts/smoke.mjs` green (exit 0, +2 static-serving checks),
  `smoke:gateway` **211/211**, `smoke:m8` **45**, `smoke:m9` **75**,
  `smoke:m10` **37**, `smoke:m11` **ALL PASS**, `smoke:m14` **ALL PASS**
- vite dev (:5174): `/`, `/admin/overview`, `/app/login` → 200 html
  (hot-reload path); `/api/admin/overview` proxied → 401
- Browser pass (built bundle on :8787): landing `/` renders (hero + 6 cards,
  screenshot); `/admin/login` sign-in → `/admin` Overview with live data +
  all-`/admin/*` sidebar; direct `/providers` → client-redirected to
  `/admin/providers`; `/app` → portal login intact. IAB locator clicks flaky
  as usual (known) — form submit driven via page-side requestSubmit.

## Verification baseline (2026-09-21, session 22 — final, post-M18)

- `npm run check` — clean (worker + web + test tsconfigs)
- `npm test` — **304/304** (+12 M17 reasoning goldens, +8 M18)
- `npm run build:web` — clean (408.3 KB js / 112.4 KB gzip)
- Smokes: `npm run smoke` green (exit 0), `smoke:gateway` **211/211**
  (+16 M17, +5 M18), `smoke:m8` **45**, `smoke:m9` **75**, `smoke:m10` **37**,
  `smoke:m11` **ALL PASS (30)**, `smoke:m14` **ALL PASS (24)**
- REDEPLOYED 2026-09-21 (session 22): the M15–M18 worker is LIVE at
  https://khateway.chengsokdara.workers.dev (version 7083678c; no new
  migrations — 0009/0010 were already applied remotely). Verified on the
  deployed URL: /health ok, /v1/models list envelope (empty — fresh remote
  DB), /api/v1/credits 401 envelope without a key, M18 unknown
  response_format.type → explicit 400 before routing.

## Verification baseline (2026-09-19, session 21)

- `npm test` — **284/284** (+14 completions); `smoke:gateway` **190/190**
  (+14 M16), `smoke:m8` **45**, `smoke:m10` **37**, others green (see the
  git history of this file for the full session-21 baseline)
- Deploy verification (M15): see the M15 block above (remote /health,
  /v1/models, chat 404 envelope, admin login, SPA — all green). The remote
  worker predates M16 — redeploy when you want the parity pack live.

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

- 2026-09-25 — **Usage dashboard filters**. `/api/admin/usage` gains
  api_key_id/model/provider/dialect params threaded through every query incl.
  the prev-window (like-for-like deltas); Usage.tsx gains a filter bar
  (Key/Model/Provider/Endpoint + Reset) and a no-match empty state; smoke.mjs
  +filter narrowing checks. check clean, 350 offline tests, smoke green,
  browser-verified. DEPLOYED (version 4fcc67c6), filters live-verified.

- 2026-09-24 — **Admin usage dashboard**. `GET /api/admin/usage` (bucketed
  series + totals + breakdowns over request_logs, all in D1), new
  `components/charts.tsx` (hand-rolled SVG stacked bars / HBars / Delta — no
  chart dep), new `/admin/usage` page (stat cards with prev-window deltas,
  requests&errors / spend / tokens charts, top models/keys/dialects),
  App.tsx NAV + legacy `/usage` redirect, smoke.mjs +6 usage checks. check
  clean, 350 offline tests, smoke green (incl. gateway 220 re-run).
  Browser-verified both ranges + empty state. DEPLOYED (version b9618f46)
  and live-verified: new bundle served, usage 401 unauth, /admin/usage
  rendering real production aggregates.

- 2026-09-24 — **P-pack shipped (4 commits) + DEPLOYED live**. cache_control
  passthrough, DO-backed login buckets, one-retry fallback backoff with
  Retry-After honoring/relay, and DO spend-cap reservations. check clean;
  350 offline tests; smoke:gateway 220; all suites green. Deployed to
  https://khateway.chengsokdara.workers.dev (version cb4ae753) and verified:
  /health ok; keyless /v1 → 401; oauth start → 302 error-redirect; device mint
  works (test row deleted); ELEVEN bad admin logins → ten 401s then a 429 —
  the P2 DO login bucket observable on production.

- 2026-09-24 — **Social sign-in release DEPLOYED live** (version 0d9a6a75,
  https://khateway.chengsokdara.workers.dev). Remote D1 already carried
  migrations 0011+0012 (device_codes + oauth_identities verified present —
  nothing pending); `npm run deploy` shipped the worker + SPA. Live
  verification: /health ok; / + /app/login 200 with the new bundle
  ("Continue with Google" string confirmed in the served JS); keyless
  /v1/models 401; unconfigured OAuth start → 302 error-redirect (mount +
  failure contract live); device /code mints (test row deleted). Operator
  step remaining: real Google/GitHub OAuth clients into the remote admin
  Settings → Social sign-in, then the manual README round-trip.

- 2026-09-24 — **Social sign-in: Google + GitHub on the portal**. User:
  khode's device sign-in needs a one-click browser step; email/password
  becomes the fallback. New `src/worker/oauth/` (`config.ts` — settings-row
  credentials copying billing/config.ts, secrets AES-256-GCM hint-only;
  `providers.ts` — hand-rolled authorize/token/userinfo faces + PURE
  normalizers), `db/oauth.ts` (pure `decideOAuthSignIn` — identity → sign
  in, verified-email match → link, else create under public_signup;
  never-link-unverified; executor refuses email conflicts instead of
  linking), `routes/oauth.ts` (/start + /callback at /api/portal/oauth,
  mounted BEFORE portalApp; state cookie = random 32B hex + b64url
  {random, provider, next} 10-min HttpOnly Lax; every failure →
  /app/login?error= with next preserved). Migration 0012: `oauth_identities`
  + `users.password_hash` nullable. Admin: GET/PATCH /api/admin/settings/
  oauth + Settings "Social sign-in" card. Web: PortalLogin social buttons +
  divider + ?error= inline; App.tsx portal guard no-ops on /app/login (the
  background me() 401 was re-navigating the login page onto itself, burying
  ?error=/?next= in a nested next= — also repairs the plain device-link
  round-trip). Tests: tests/worker/oauth.test.ts (22 offline), NEW
  scripts/smoke_oauth.mjs (14 checks incl. the mount-order proof), all
  pre-existing suites still green; check + 326 offline tests clean; UI
  verified in-browser. Manual Google/GitHub round-trip steps in README.

- 2026-09-24 — **Keyless removed (session 29)**. User: device login replaced
  the need for keyless entirely. gateway.ts auth middleware → always-strict
  (401 without a valid enabled key; message points at khode /login or the
  portal); settings.ts dropped enforcement/gate/guest flags (cache now only
  rate limits + cache flags); admin settings GET/PATCH + Settings/ApiKeys
  UI cards stripped of the keyless surface; smoke suites re-anchored (no-auth
  / anonymous / disabled → 401; IP-bucket tests removed as unreachable;
  enforcement + gate + guest-pool blocks deleted). Deployed and verified
  live (keyless → 401, device mint + settings shape correct). 209 gateway +
  33 m10 + all other suites green.

- 2026-09-24 — **Device-flow onboarding + guest-pool debit (session 28)**.
  User: khode is built for other people — keyless had no identity, no
  ceiling, no attribution. Device flow: `routes/device.ts` (/api/v1/device
  code+token, RFC 8628), `device_codes` table (migration 0011), portal
  `GET /device/:code` + `POST /device/:code/approve`, `/app/device` page
  (PortalDevice.tsx) + `?next=`-preserving portal login. Guest pool:
  `settings.keyless_guest_user_id` + snapshot, gateway `guestUser`
  resolution in the auth middleware, three LogDraft sites + balance gate,
  admin settings GET/PATCH + Settings-card row. khode: `internal/khateway`
  client (+httptest suite + live probe), `internal/ui/devicelogin.go`
  `/login` dialog (poll loop, open-browser, key → auth.json, provider
  switch, model auto-pick), settings key-row hint + /help entry. Tests:
  smoke_device.mjs (21 checks), smoke_gateway +12 guest-pool checks (242);
  check + npm test + all seven smoke suites green; khode go green.

- 2026-09-24 — **Keyless gate: client-build attestation for khode
  (session 27)**. User: keyless access must only work from OFFICIAL khode
  builds — even once khode is open-source, builds from the repo must not
  ride keylessly. Shipped (gate OFF by default — zero behavior change until
  an admin sets a secret):
  - **Gateway** (`routes/gateway.ts` auth middleware): when the settings row
    `keyless_gate_secret_hash` exists, requests with no valid enrolled key
    must present `x-khateway-access` whose sha-256 timing-safely matches
    (`sha256Hex` + `safeEqualHex`); otherwise 401 `unauthorized_client` in
    the path's dialect. Applies to disabled-key riders too (they're
    anonymous traffic); enrolled keys skip the gate; enforcement-on mode
    401s first (`invalid_api_key`).
  - **Settings** (`db/settings.ts`): `keyless_gate_secret_hash` row — only
    the sha-256 is stored (plaintext never persisted); `getKeylessGateHash`
    rides the 5 s snapshot cache (fail-open = gate off, safe: without D1 no
    model resolves); `setKeylessGateSecret(secret|null)` hashes or deletes
    + patches the isolate cache.
  - **Admin API** (`routes/admin.ts`): GET `/api/admin/settings` adds
    `keyless_gate: 'on'|'off'` (never the hash); PATCH accepts
    `keyless_gate_secret` (16–256 chars sets/rotates, `''`/null clears).
  - **Admin UI**: "Keyless access" section in the Gateway & accounts card —
    status, password input, Set/Rotate + Disable buttons (`Settings.tsx`,
    `api.ts` DTO).
  - **khode side** (`~/Apps/khode`): `llm.khatewayAccessSecret` baked via
    ldflags by `scripts/build-release.sh` (`KHODE_ACCESS_SECRET` env, never
    committed); header attached on both SDK faces + FetchModels; repo builds
    send nothing. khode tests pin header on/off per build type.
  - **Tests**: smoke_gateway.mjs +14 checks (230 total) — gate on: keyless
    401 without/wrong header on both envelopes, 200 with it (models + chat),
    enrolled key unaffected, disabled key gated, short secret 400,
    enforcement wins, clear → keyless again. `npm run check` clean; npm test
    304/304; all six smoke suites green.

- 2026-09-24 — **Landing page admin links removed (session 26)**. User:
  admin is operator-only, shouldn't look prominent publicly. `Landing.tsx`:
  header "Admin console" emerald button, hero "Admin sign in" CTA and footer
  "Admin" link all deleted; Portal promoted to the header emerald button;
  comment documents that /admin is deliberately unlinked (URL/bookmark only).
  `npm run check` clean; no worker changes.

- 2026-09-23 — **Fetch/import models moved to the Models page; fetch-first
  "Add models" modal (session 25)**. Models.tsx: segmented modal (Fetch from
  provider — provider select + fetch + filterable picker with already-added/
  unsupported badges + footer Import; Custom model — the manual form), edit
  modal unchanged. Providers.tsx: discovery UI removed. admin.ts: import-models
  accepts enriched `{models:[…]}` bodies (legacy `model_ids` intact) and
  listUpstreamModels falls back to `DEFAULT_BASES[adapter]` when the provider
  has no base_url. api.ts: `importModels` sends `{models}`, `fetchModelsPreview`
  removed. vite.config.ts proxy key `/api` → `^/api/` (was swallowing the
  app's `/api.ts` module — blank dev UI). smoke_gateway 212 → **216** (+4
  enriched-import checks). Verified: check ×3, vitest 304/304, smoke_gateway
  216/216, browser pass (fetch/filter/select/import/re-fetch/custom tab/
  provider modal).

- 2026-09-23 — **Routing restructure: /api for all management APIs, /admin +
  /app as pure page prefixes, public landing at / (session 23)**. Admin API
  `/admin/*` → `/api/admin/*`, portal+orgs `/app/api/*` → `/api/portal/*`
  (index.ts mounts + api.ts/portal-api.ts + all smoke scripts; `/v1` and
  `/webhooks/lemonsqueezy` untouched). wrangler run_worker_first now
  `/v1(/*)`, `/api(/*)`, `/webhooks(/*)`, `/health` — `/admin/*` pages are
  served by the assets SPA fallback like `/app` (no worker middleware).
  New `pages/Landing.tsx` at `/`; App.tsx admin routes moved under `/admin`
  with LEGACY_ROUTES client redirects (new `replace()` in router.tsx);
  vite proxy `/admin`+`/app/api` → `/api`. Verified: check, vitest 304,
  all seven smokes, curl matrix on :8787 + :5174, browser pass (landing,
  login → admin, legacy redirect, portal).

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
  - `/api/admin` has no CSRF hardening (SameSite=Lax + HttpOnly, single origin). Fine internally; revisit if ever exposed publicly.
  - `wrangler 4.133.0` available (on 4.132.0) — informational, stack is frozen per RULES.md.
  - ~~Remote deploy prerequisites not yet done~~ **DONE (session 21)**:
    deployed to https://khateway.chengsokdara.workers.dev (remote D1 + secrets
    set). The remote DB starts EMPTY — register real providers/models in the
    deployed admin console; real Lemon Squeezy credentials still needed on
    admin Settings → Billing before top-ups work there.
  - Models with **null pricing cost portal users nothing** (unknown cost never debits) — set pricing before selling access to a model.
  - Portal accounts have **no email verification** (no email sender on Workers) — deliberate M8 deferral.
