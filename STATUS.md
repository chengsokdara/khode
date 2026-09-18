# STATUS.md — Progress Tracker

One-glance project state. Update at the end of **every** task (see
`RULES.md`). Historical detail belongs in `MEMORY.md`, not here.

## Roadmap

- [x] **Phase 0/1 — Skeleton chat (TUI + Anthropic streaming)**
  - [x] Go module, repo init, `.gitignore`, README
  - [x] `internal/llm` provider abstraction (`Provider`, `Event` channel)
  - [x] Anthropic provider (streaming, usage, cancellation)
  - [x] Bubble Tea app: viewport chat, textarea input (grow 1→6 lines),
        spinner status bar, token counter, help line
  - [x] glamour markdown rendering of completed replies
  - [x] JSONL session persistence + `--resume`
  - [x] Slash commands: `/help`, `/new`, `/model <name>` (persisted),
        `/exit`
  - [x] Esc stops an in-flight stream; Ctrl+C quits
- [x] **Phase 2 — Provider layer + polish**
  - [x] OpenAI provider behind the same `llm.Provider` interface
        (`openai/openai-go`); selection via a `--provider` flag for now
  - [x] Provider selection in config (`config.Provider` + per-provider
        model defaults), superseding the `--provider` flag default
  - [x] Cost estimate from a per-model price table
  - [x] Session picker / named sessions
  - [x] Unit tests for session + config (+ more provider translation
        cases; `llm` has fake-SSE tests for OpenAI and Anthropic)
- [x] **Phase 3 — Read-only tools + agent loop**
  - [x] `internal/tools`: `Tool` interface + registry
  - [x] `read`, `glob`, `grep` tools
  - [x] Agent loop: LLM decides tool calls, results fed back until done
- [x] **Phase 4 — Full agent (write tools + permissions)** ⭐ milestone
  - [x] `edit` (unique string-replacement), `write`, `bash` (timeout +
        output caps)
  - [x] Permission modes: plan / ask / accept-edits / auto
  - [x] Diff preview + approval dialog in the TUI
- [x] **Phase 5 — Agent quality**
  - [x] AGENTS.md-style project context in system prompt
  - [x] Context compaction when nearing the token window
  - [x] Todo tracking tool, API retry/backoff
- [x] **Phase 6 — Advanced**
  - [x] MCP client (stdio JSON-RPC, no SDK): `mcp_servers` config,
        tools registered as `mcp__<server>__<tool>`, per-server risk
        override, `/mcp` status
  - [x] Subagents: `task` tool runs a fresh Runner on an in-memory
        session and returns the final report
  - [x] Plan mode workflow: `plan` tool presents a plan, approval in
        the TUI switches to accept-edits
  - [x] Hooks: `pre_tool` (veto with exit 2) and `post_tool` shell
        hooks from config
- [x] **Phase 7 — Configurable in the TUI**
  - [x] API keys in `~/.khode/auth.json` (0600, atomic write); env
        vars still win (`llm.Resolve`)
  - [x] Keyless startup: no env gate; with no credentials anywhere the
        settings overlay opens on the api-key row; pre-flight check
        stops keyless turns with a pointer to `/settings`
  - [x] `/settings` overlay: provider (live switch), api key, base
        url, model, max tokens, mode — every row saves on commit
  - [x] MCP servers + hooks edited in the TUI; MCP servers started,
        stopped, and restarted live from the overlay

## Now

Phase 7 complete — nothing in khode needs hand-editing config.json.
First run (no credentials anywhere) opens a walkthrough overlay, not
settings: intro card → pick provider (←/→, saved live) → paste the API
key (masked, into auth.json) → a ready card ending in an explicit
"enter to start chatting"; esc skips any step. `/settings` (alias
`/config`) remains the full editor — every row persists the moment it
commits and its footer keys render highlighted. Custom providers
(Ollama, OpenRouter, proxies — anything OpenAI-compatible or speaking
the Anthropic protocol) are managed in the provider list on the
provider row: `n` adds one (name, protocol, base URL), and it
activates immediately; credentials resolve through
`config.Credentials` with `<NAME>_API_KEY`-style env overrides. The
model row opens a picker that fetches the endpoint's model list (real
HTTP per protocol, off the UI goroutine), caches it in
`model_choices`, and falls back to manual add (n) when the endpoint
can't list; customs never inherit a built-in default model — an unset
model blocks the turn with a pointer to the picker. The status line
shows the context meter "ctx NN%" (warning at the 80% auto-compact
trigger). Provider names keep the casing they were saved with —
custom-provider, models, model-choice, and auth-key lookups fall back
to case-insensitive matching, and Load snaps the active name to the
stored custom-provider key; a protocol that still doesn't resolve
warns at startup and falls back to the anthropic client instead of
exiting. The chat input drops bubbles' hard black cursor-line
background, which rendered as a black strip inside the input box on
dark terminal themes. Keys live in `~/.khode/auth.json` (0600, atomic
rename) with env vars keeping precedence. MCP changes apply live via
`applyMCPCmd`; hook edits apply next turn. The registry has an RWMutex
(agent loop reads it while the overlay mutates it); `Model.partial` is
a pointer `strings.Builder` (see Gotchas).

**khateway built-in (2026-09-17):** khode talks to a self-hosted
Khateway router as a third built-in provider — one base URL + one
client key (`khat-…`) unlock every model the gateway admin configured.
The endpoint shape picks the wire protocol (…/v1/messages → anthropic
face, otherwise openai face; both serve `/models` listings); the model
row opens the auto-fetch picker; khateway never inherits a vendor
default model. Env: `KHATEWAY_API_KEY` / `KHATEWAY_BASE_URL`.

**Selectable text + thinking (2026-09-17):** mouse capture is off at
startup, so drag-select and the terminal's copy-on-select work natively
(anyway: shift+drag selects even under capture). alt+m toggles capture
for wheel scrolling, and pgup/pgdn always scroll the chat. Model
reasoning is now separated from the answer: `llm.ThinkingDeltaEvent`
carries it (Anthropic thinking blocks; DeepSeek-style
`reasoning_content` read from the delta's raw JSON; inline
`<think>…</think>` tags split out of OpenAI-protocol content even when
the tags straddle deltas), the agent loop stores it on the assistant
message (`thinking` session field, never replayed to providers), and
the TUI renders it as a dimmed italic `✻` block that collapses into its
own bubble ahead of the markdown answer.

**khateway on first run + dev workflow (2026-09-17):** the walkthrough
gained a model step between key and ready: whenever the chosen provider
has no model yet (khateway, customs — only the endpoint knows its
list), khode fetches it off the UI goroutine and the user picks one
right there, so "choose khateway → use right away" holds; a failed
fetch (gateway down) degrades to the old /settings pointer. Fetch
results now route to the walkthrough's step when it is open (settings
picker keeps precedence). Development workflow: `--debug` redirects the
standard logger to `khode-debug.log` (stderr writes corrupt the alt
screen), `internal/debug.Printf` is the gated logging call, and
README → Development documents the loop (build/vet/test/run, fake-SSE
tests, base-URL overrides, delve).

**khateway keyless-native (2026-09-17):** khode no longer requires any
client key for khateway — `config.KeyOptional` exempts it from the
pre-flight key check (turns and /compact), the walkthrough's key step
is skipped (choose khateway → straight to the model list → ready), and
the settings api-key row reads "not required". With no key configured,
requests carry an `anonymous` placeholder credential (Bearer / x-api-key):
the anthropic SDK would otherwise refuse client-side and the openai SDK
would leak OPENAI_API_KEY as the bearer token. `KHATEWAY_API_KEY` and a
stored key still work as optional overrides for gateways that enforce
client keys — the gateway side is expected to treat auth as optional.

**khateway select-only (2026-09-17):** khateway is no longer editable
in the TUI — `config.ManagedEndpoint` makes its endpoint fixed. The
provider list only selects it (enter activates, d refuses removal like
any built-in, the add/edit form rejects the name), and the base-url row
is read-only while khateway is active: it displays the effective
endpoint (env override → stored value → the built-in default), enter
explains `KHATEWAY_BASE_URL` instead of opening the editor, and the
commit path refuses writes as defense in depth. The api-key row stays
paste-able as the optional override for enforcement-mode gateways; the
model row stays fully usable (picking a model is using the provider).

**UI polish — the aurora design system (2026-09-18):** every view now
draws from `internal/ui/styles.go`: cyan (`#2DD4BF`) is khode's own
activity (borders, tools, spinner, keycaps), green (`#4ADE80`) is good
(ready, saved, additions), dim teal-gray carries secondary text, and
red/amber are reserved for errors and context pressure. The chat header
shows a green→cyan gradient wordmark, provider/model, and a
session + permission-mode chip over a quiet rule; the status line
counts the streaming turn's elapsed time and renders a `▰▱` context
meter ahead of the ctx label; streaming replies trail a cyan block
cursor and the input border tints cyan while a turn is live. All four
overlays (sessions picker, permission/plan dialogs, settings,
walkthrough) share one dialog grammar: cyan rounded box, ◆ title +
dim subtitle, keycap footer chips, styled list cursors, flash-colored
✓/✗ notes; the walkthrough gains step-progress dots and a spinner on
its model-fetch state. Frames can be eyeballed off a tty with
`DUMP_DIR=/tmp/x go test ./internal/ui -run TestDumpViews` (writes raw
+ ANSI-stripped views; skipped when DUMP_DIR is unset).

## Next

Backlog (no committed order):

1. Stream subagent activity into the TUI instead of hiding it.
2. MCP: re-list tools on `tools/list_changed`; resources/prompts.
3. Hooks: feed post_tool output to the model as feedback.
4. OpenAI tool-call unit parity for MCP edge cases as they surface.

## Changelog

| Date | Change |
|---|---|
| 2026-09-16 | Phase 1: TUI chat + Anthropic streaming + sessions + docs | baa7520 |
| 2026-09-16 | OpenAI provider (`openai-go` v1.12) + `--provider` flag + fake-SSE provider test | 7ae2922 |
| 2026-09-16 | Provider selection in config: `provider` + per-provider `models` map, legacy migration, flags → overrides | 3de9993 |
| 2026-09-16 | Cost estimate from per-model price table (`llm.Price`, longest-prefix match, status-line `$`) | c9cc6ab |
| 2026-09-16 | Named sessions + `/sessions` picker + `--continue` / `--resume[=name]`, mtime-ordered listings | 50bfda7 |
| 2026-09-16 | Tests: config Load/Save (temp HOME) + Anthropic fake-SSE translation | af2faf7 |
| 2026-09-16 | Phase 3: tools in the llm contract (tool defs/calls/results/events, provider translation + fake-SSE tests) | ecb9255 |
| 2026-09-16 | Phase 3: `internal/tools` registry + read/glob/grep (stdlib `**` glob, output caps) | 57c6c43 |
| 2026-09-16 | Phase 3: agent loop (`agent.Runner`), session v2 tool lines, malformed-input hardening | a997292 |
| 2026-09-16 | Phase 3 finished: TUI tool activity + `/tools`, first ui tests, untrack junk files | c3eac1a |
| 2026-09-17 | Phase 4: edit/write/bash tools + LCS diff helper (`UnifiedDiff`, `DiffStat`) | 2c277fa |
| 2026-09-17 | Phase 4: `internal/perm` modes × risk decisions, config field, agent-loop gate + `Approver`/`Bridge` | 557bafe |
| 2026-09-17 | Phase 4 finished: TUI approval dialog with diff/command preview, `/mode`, docs | f1483c7 |
| 2026-09-17 | Phase 5: AGENTS.md/CLAUDE.md project context in the system prompt (`agent.SystemPrompt`) | f1c8f78 |
| 2026-09-17 | Phase 5: transient-failure retry with backoff in both providers (no retry after content) | 5d441f3 |
| 2026-09-17 | Phase 5: `todo` task-list tool, rendered whole in the TUI | bc422f2 |
| 2026-09-17 | Phase 5: context compaction (80% trigger, clean-boundary cut, atomic rewrite) + `llm.ContextWindow` + `/compact` | 98eccb1 |
| 2026-09-17 | Phase 6: MCP stdio client + `mcp_servers` config + registry bridge + `/mcp` | 1af8588 |
| 2026-09-17 | Phase 6: `task` subagent tool on in-memory sessions | 0d21ba2 |
| 2026-09-17 | Phase 6: `plan` tool + plan-approval dialog → accept-edits | 94d1049 |
| 2026-09-17 | Phase 6: pre/post tool-use hooks with pre_tool veto | 698ffba |
| 2026-09-17 | Phase 7: auth.json key store (0600, atomic) + `base_urls`; llm keyed constructors + factory; registry RWMutex + RemoveMCP | b46b15f |
| 2026-09-17 | Phase 7: `/settings` overlay, keyless startup + first-run setup, live MCP apply | 2351355 |
| 2026-09-17 | Phase 7: first-run walkthrough, highlighted overlay exits, status-line context meter | 3265b34 |
| 2026-09-17 | Phase 7: custom providers (any OpenAI/Anthropic-protocol endpoint), model-list fetching with manual fallback | 002796f |
| 2026-09-17 | Phase 7: custom providers in the first-run walkthrough (inline add form) | 6a25702 |
| 2026-09-17 | Fix: provider names keep their casing (case-insensitive lookups), bad protocol warns + falls back at startup, chat input's black cursor-line strip removed | 557a92a d4426e0 |
| 2026-09-17 | khateway built-in provider: protocol picked from the endpoint shape (`llm.KhatewayProtocol`), model picker auto-fetch, no default model, `KHATEWAY_*` env vars; verified green on a clean worktree (parallel reasoning-WIP in-tree was unrelatedly red, untouched) | 662958b |
| 2026-09-17 | Selectable text: mouse capture off by default (alt+m toggles wheel-scroll capture, pgup/pgdn scroll); thinking split from response (`llm.ThinkingDeltaEvent`, `<think>` stream splitter, `reasoning_content` raw-JSON read, `thinking` session field, ✻ display block) | 2a3a6c6 |
| 2026-09-17 | Walkthrough model step: auto-fetch + pick for khateway/custom providers (no model yet) between key and ready; fetch-failure degrades to /settings pointer; `--debug` flag + `internal/debug` gated logging + README Development section | 945836c |
| 2026-09-17 | khateway keyless-native: `config.KeyOptional` exempts it from pre-flight + walkthrough key step; missing key becomes the `anonymous` placeholder (no SDK env fallback, no client-side refusal); gateway side treats auth as optional | 0ec4212 |
| 2026-09-17 | khateway select-only: `config.ManagedEndpoint` locks the endpoint — base-url row read-only (shows effective URL, enter explains `KHATEWAY_BASE_URL`), commit path refuses, provider list enter=select / d=refused; model + api-key rows stay usable | 4f7962a |
| 2026-09-18 | UI polish: aurora design system in styles.go (green/cyan palette, keycap chips, gradient wordmark, ▰▱ meter) + restyled chat chrome (mode chip header, live elapsed timer, streaming cursor, two-tone tool calls) | eddae69 |
| 2026-09-18 | UI polish: overlays share the dialog language (picker/perm/settings/walkthrough: ◆ titles, keycap footers, styled cursors, flash notes, step dots, fetch spinner) | ecdf9bd |
| 2026-09-18 | UI: view-dump harness (`TestDumpViews`, DUMP_DIR) for inspecting frames off a tty; go mod tidy promotes termenv/openai-go to direct (no version changes) | 1645c5c |
| 2026-09-18 | Fix: startup banner no longer repeats the header (version/provider/model/session/mode live there now) — it only points at /help and /settings | 3dfba3b |
