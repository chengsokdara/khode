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

**/model picker dialog (2026-09-22):** bare `/model` opens a centered
model chooser (`internal/ui/modelpick.go`, the /sessions dialog shape)
instead of printing a usage line: the provider's cached choices with the
active model dotted and the cursor pre-set on it, type-to-filter
(case-insensitive substring; j/k spell — arrows and ctrl+p/n navigate,
the one picker without vim keys), and `f` to fetch the endpoint's live
list through the shared `fetchModelsCmd` (auto-fetch on open when the
cache is empty; results land via a `modelPick` branch in
`applyFetchedModels`; a failed fetch shows a status note with f retry).
enter commits via `cfg.SetModel` + save with the usual notice — the
switch is effective next turn, since each turn's Runner reads
`cfg.Model()`. `/model <name>` still sets directly, and the completion
table's model row now takes no args so popup-enter runs bare `/model`
immediately (one enter opens the picker).

**/mcp servers dialog (2026-09-22):** `/mcp` opens a centered server
list (`internal/ui/mcp.go`, the /tools panel shape) instead of printing
a status block: one row per configured server (sorted) with a live
status glyph (● running / ○ unavailable / spinner while a reconcile is
in flight), registered tool count with session-disabled count, and the
server's risk class; a detail block under the list shows the highlighted
server's launch line and tool names. enter starts or restarts the
highlighted server through the shared `applyMCPCmd` (whose reconcile
also heals any other stopped server), space toggles all of the server's
tools for this session (all-on ↔ all-off, the /tools semantics in bulk),
esc closes. Statuses render from live state (`m.mcpClients` + registry
prefix scans) every frame; `applyMCPResult` clears the dialog's busy
marks, and the old `mcpStatus()` text is gone.

**Bottom-pinned inline frame (2026-09-19):** the chat input now sits
glued to the terminal's bottom edge at all times — the full-screen
inline look of Claude Code — instead of floating under the banner with
dead terminal rows below. flush() tops every seal chunk up with blank
rows (same atomic insertAbove, so fills can never race prints) sized by
a two-regime law derived from uv's renderer: in the no-scroll regime
the chunk must end exactly one row short of the terminal bottom; in the
scroll regime the seal re-pins by itself, and the one case that can't
(a seal coinciding with a frame-height change — the completion popup
closing on submit, say) is healed by a refill that runs one render tick
later (pinTick). Update's wrapper mirrors uv's asymmetric re-anchoring
(growth scrolls and keeps the bottom glued; shrink needs the refill)
and tracks the two state fields the math needs (`top`, `hModel`).
Verified in tmux capture-panes (real emulator — pyte mis-parses kitty
sequences): boot, seals, overlay grow/close, shift+tab, and multiline
input all end with the help line on the last terminal row and clean
scrollback. Follow-ups from the user's first pinned run: the mouse is
captured again (wheel swallowed — under a full-screen pinned frame the
wheel must not scroll the scrollback out from under it; Claude Code
consumes the wheel the same way; history stays reachable via the
scrollbar and terminal search, selection via shift+drag), the
header is built one column short of the terminal — flush's left-edge
alignment prefix made the full-width rule and the mode chip wrap onto
extra rows — and a blank pad now absorbs transient shrink (see the
next entry).

**Full-screen rendering (2026-09-21):** the inline+scrollback
experiment is reverted — five successive rounds of renderer artifacts
(ghost boxes, lingering gaps, line-by-line crawls, duplicated frame
fragments) all traced to the same root: the inline renderer cannot
erase rows a shrunken frame vacated, and every workaround fought that
constraint. khode now runs FULL SCREEN on the alternate buffer
(tea.View.AltScreen) the way Claude Code does: the whole terminal
repaints every frame, so the popup overlays the conversation and
erases cleanly on close, nothing can leak into scrollback, and the
input sits at the bottom of a frame that is exactly terminal-height — spare rows pad ABOVE the content (the frame is bottom-pinned; the empty area at boot is where history grows), and the viewport is a fixed-size window that slides on pgup/pgdn (a page at a time, snapped to the live edge on submit and stream events), never changing the frame's height. The mouse is deliberately NOT captured: drag selects any visible text natively (alt-buffer rows are real screen cells) — the selection lost with the alt screen is back — and the wheel belongs to nothing, since the alt buffer has no scrollback for it to move. The seeded "/help commands" banner message is gone (it read as misplaced chrome; the slash popup surfaces commands on "/").
The conversation renders in an in-app viewport (sealed blocks from
their render cache plus the streaming block), the captured mouse wheel
scrolls it (m.scroll, snapping to the live edge on submit and stream
events), and all the inline machinery — flush printing, printed
watermark, lastPrint, top/hModel tracking, tail buffer, bandExtra,
pad/drain/pinTick — is deleted; flush is a documented no-op kept for
its call sites.

**Bottom-pinned inline frame (2026-09-19):** the chat input now sits
glued to the terminal's bottom edge at all times — the full-screen
inline look of Claude Code — instead of floating under the banner with
dead terminal rows below. flush() tops every seal chunk up with blank
rows (same atomic insertAbove, so fills can never race prints) sized by
a two-regime law derived from uv's renderer: in the no-scroll regime
the chunk must end exactly one row short of the terminal bottom; in the
scroll regime the seal re-pins by itself, and the one case that can't
(a seal coinciding with a frame-height change — the completion popup
closing on submit, say) is healed by a refill that runs one render tick
later (pinTick). Update's wrapper mirrors uv's asymmetric re-anchoring
(growth scrolls and keeps the bottom glued; shrink needs the refill)
and tracks the two state fields the math needs (`top`, `hModel`).
Verified in tmux capture-panes (real emulator — pyte mis-parses kitty
sequences): boot, seals, overlay grow/close, shift+tab, and multiline
input all end with the help line on the last terminal row and clean
scrollback. Follow-ups from the user's first pinned run: the mouse is
captured again (wheel swallowed — under a full-screen pinned frame the
wheel must not scroll the scrollback out from under it; Claude Code
consumes the wheel the same way; history stays reachable via the
scrollbar and terminal search, selection via shift+drag), the
header is built one column short of the terminal — flush's left-edge
alignment prefix made the full-width rule and the mode chip wrap onto
extra rows — and a blank pad now absorbs transient shrink (see the
next entry).

**No more transient ghosts in history (2026-09-19):** closing the
command popup or the /mode picker used to leave the box's pixels
painted above the input — uv's diff renderer only repaints rows the
frame still occupies, so the rows a shrunken frame vacated kept their
old content and eventually scrolled into the transcript. The chat view
now renders a blank pad (`padRows`, capped at `maxPadRows`) that
Update's wrapper grows by exactly the shrink delta, keeping the frame's
total height — and the bottom edge — constant through a transient's
whole life; the same-size repaint erases the transient's pixels
instead. The pad then drains: while the terminal is quiet and pinned,
one pad row is retired per tick (drain and its heal blank are separate
ticks — printing in the same pass races the render), so the popup's
space flows back to history within a fraction of a second. Opening the
next transient consumes the pad first (the slot is reused), and big
overlay closes beyond the cap fall back to the delayed refill. Known
limitation: a stray row can still survive into history in long mixed
sequences — uv exposes no erase-above primitive, so residue can be
minimized but not made impossible. Second half of the fix: the pad
drains — while quiet and pinned, one row is retired per tick and the
next tick's refill re-seats the frame — and the wrapper's shrink-absorb
schedules the wake tick itself, because ticks otherwise fire only when
flush prints and a seal-less popup cycle (type "/", delete it) would
never start the drain.

**shift+tab mode cycling (2026-09-19):** shift+tab walks the permission
modes (plan → ask → accept-edits → auto, wrapping via `perm.Next`)
whenever no overlay is open — welcome and settings keep the key for
their own navigation. Cycling persists to config.json but stays quiet
(no chat notice per press): the feedback is a Claude-Code-style mode
line just above the input — `⏵⏵ accept-edits · file changes run
freely; commands still ask · shift+tab to cycle`, tinted per mode
(plan cyan / accept-edits green / auto amber) and hidden in the default
ask mode; its row is counted in `liveChrome`. Bare `/mode` opens an
interactive picker above the input in the command-popup grammar (↑/↓ +
enter applies via `setMode` with the usual notice, esc dismisses, the
active mode is marked "(current)"); `/mode <name>` and the /settings
mode row are unchanged. Cycling mid-turn is allowed — the in-flight
turn keeps its Runner mode snapshot and the next turn picks the new
mode up.

**Inline transcript rendering (2026-09-19):** khode no longer runs in the
alt screen. Sealed chat blocks are `tea.Println`'d into the terminal's
real scrollback the moment they seal — the user message at submit, tool
activity as it lands, thinking when the answer starts, the final answer
at turn end — so the native scrollbar, wheel, and text selection cover
history (mouse capture is gone for good; with no viewport left there is
nothing for captured wheel events to scroll). The redrawn live region
holds only the in-flight turn: the streaming block (tail-clipped to the
height budget, never lost — the full text prints when it seals), the
status line (now carrying the mode chip + model that used to live in
the header), the completion popup, and the input. The whole frame stays
≤ terminal height − 2 because bubbletea v2's Println garbles a
full-height frame. The gradient header prints once into scrollback at
startup and on session switches (banner-in-scrollback, user choice);
a restored transcript prints in the same chunk on the first
WindowSizeMsg (wrap width must exist first), and switching sessions
re-prints it — picked sessions show their history for the first time.
Overlays render as bounded, horizontally centered boxes instead of
covering the screen: the session picker and the settings provider/MCP/
hooks lists gained sliding windows (`listWindow`), the perm preview cap
tightened, and the popup yields rows on short terminals so the live
region always fits. Verified in a real pty: banner + transcript insert
above the frame, no `[?1049h` altscreen escape anywhere, pre-flight
notice prints to scrollback after submit.

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
exiting. Keys live in `~/.khode/auth.json` (0600, atomic
rename) with env vars keeping precedence. MCP changes apply live via
`applyMCPCmd`; hook edits apply next turn. The registry has an RWMutex
(agent loop reads it while the overlay mutates it); `Model.partial` is
a pointer `strings.Builder` (see Gotchas).

**Interactive /tools (2026-09-18):** `/tools` opens the tool panel — a
picker-style overlay in the dialog language listing every registered
tool (built-in, task/plan, and `mcp__server__tool`) with a risk badge
(read dim / write amber / exec red) and a one-line description, in a
sliding scroll window. enter or space toggles the tool under the
cursor; toggles are session-scoped state on the registry (`disabled`
set — nothing touches config.json): `Definitions()` stops advertising
disabled tools so the model can't see them, and the agent loop rejects
calls to them with an error result the model can recover from.
Removing an MCP server purges its tools' toggles, so re-adding starts
fully enabled. khode runs on Bubble Tea / Bubbles / Lip Gloss **v2**
(charm.land/*, migrated 2026-09-19), which enables the kitty keyboard
protocol automatically: shift+enter is a real key out of the box on
protocol terminals (iTerm2 3.5+, kitty, Ghostty, WezTerm) and inserts
a newline, plain enter submits, and alt+enter remains the fallback on
legacy terminals (Apple Terminal has no protocol support — the
terminal-mapping workaround still applies there, same as Claude Code).
Mouse capture went through three iterations in two days under the alt
screen (toggle → dropped → permanently on) and is now gone entirely:
inline rendering (2026-09-19) made history real scrollback, so the
wheel, scrollbar, and selection are the terminal's own again.

**Slash-command completion (2026-09-18):** typing `/` in the chat
input floats a completion popup just above it — input-box width, a
left-aligned command column with one-line descriptions, a key
cheatsheet footer, and up to 8 rows with a scroll window around the
cursor. It filters by case-insensitive prefix as you type (an exact
match jumps to the front), ↑/↓ moves with wraparound, tab fills
`/name `, enter fills too and runs the command at once when it takes
no arguments (fill-only while a turn is streaming), and esc dismisses
while keeping the typed text. The `slashCommands` table in
`internal/ui/complete.go` is the single source of truth — `/help`
renders from the same list, so the aliases (`/config`, `/quit`) are
finally documented and popup/help can't drift. Opening the popup
carves its rows out of the chat viewport; frames are in the dump
harness (`popup*.txt`).

**khateway built-in (2026-09-17):** khode talks to a self-hosted
Khateway router as a third built-in provider — one base URL + one
client key (`khat-…`) unlock every model the gateway admin configured.
The endpoint shape picks the wire protocol (…/v1/messages → anthropic
face, otherwise openai face; both serve `/models` listings); the model
row opens the auto-fetch picker; khateway never inherits a vendor
default model. Env: `KHATEWAY_API_KEY` / `KHATEWAY_BASE_URL`.

**Selectable text + thinking (2026-09-17):** mouse capture is on from
launch (Claude Code and opencode do the same — the wheel scrolls the
chat instead of the terminal scrolling out of the TUI into the dead
pre-launch scrollback). Text selection survives via the shift+drag
override every major terminal keeps for mouse-reporting apps
(Terminal.app, iTerm2, kitty, Ghostty), and Terminal.app's View >
Allow Mouse Reporting (⌘R) is the full escape hatch; pgup/pgdn also
scroll. Model
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
5. Khode /terminal-setup: write the Terminal.app/iTerm2 shift+enter
   mapping khode's alt+enter fallback already picks up.

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
| 2026-09-18 | Slash-command autocomplete popup above the input (prefix filter with exact-match-first, wraparound nav, tab fills, enter runs argument-free commands, relayout carve-out); `slashCommands` table now feeds both the popup and `/help`; popup dump frames; real-pty e2e via expect with a sized pty | c5ebf4e |
| 2026-09-18 | Interactive `/tools` panel: session-scoped enable/disable on the registry (`Definitions` filters, execCall rejects with a recoverable error, RemoveMCP purges toggles), overlay in the dialog language with risk badges + scroll window, registry/loop/ui tests + dump frames | 4d87a87 |
| 2026-09-18 | Input keys: alt+m footer hint says "wheel scroll"; alt+enter-only newline constraint documented in code (bubbletea v1 can't parse kitty-protocol keys → shift+enter unrepresentable) | 63442c7 |
| 2026-09-18 | Fix: mouse capture toggles with ctrl+o — alt+m never fired on default macOS (option composes µ, no alt key event); alt+m kept as meta-terminal alias, footer/notes/comment updated, toggle test | 44193ac |
| 2026-09-18 | Mouse capture removed entirely (Claude Code parity: never grab the mouse) — footer hint, toggle, MouseMsg forward, and tests dropped; pgup/pgdn scroll, selection/copy native; inline-scrollback rendering added to the backlog | bef8b9b |
| 2026-09-18 | Mouse capture restored permanently: WithMouseCellMotion at startup, wheel feeds the viewport (Claude Code/opencode consume wheel the same way — user-verified in Apple Terminal); selection via shift+drag override, ⌘R escape hatch; wheel test | ebec1a7 |
| 2026-09-18 | Footer follows the standard: newline hint is shift+enter, binding lists both shift+enter and alt+enter; physical shift+enter still submits on unmapped terminals (bubbletea v1 parses no modified keys) | bc7e4e9 |
| 2026-09-18 | Regression test pinning the modifier-enter wiring: ESC+CR (what a terminal-mapped shift+enter sends) parses to alt+enter and inserts a newline without submitting | 36c428a |
| 2026-09-19 | Bubble Tea/Bubbles/Lip Gloss v2 migration (v2.0.9/v2.2.1/v2.0.6): kitty protocol on → shift+enter works out of the box in iTerm2/kitty/Ghostty/WezTerm; tea.View declarative altscreen+mouse, KeyPressMsg (Code/Text/Mod), MouseWheelMsg forwarding, textarea SetStyles+InsertNewline rebinding, "space" matches, PasteMsg passthrough, dump harness drops termenv; pty smoke test boots+exits clean | e40738c |
| 2026-09-19 | Fix: after shift+enter the input box showed two empty prompt rows (typed line scrolled above, reachable only by arrowing up) — khode's external SetHeight raced the textarea's cursor-follow scroll. Fixed with v2's native DynamicHeight (Min/MaxHeight + large MaxContentHeight so input is never blocked, matching v1), maybeGrowInput deleted, syncInputLayout gives height changes back to the chat viewport; render-assertion regression test | d6ba85a |
| 2026-09-19 | Inline transcript rendering (backlog 1): alt screen + mouse capture retired; sealed turns tea.Println into real scrollback as they seal; live region = streaming turn + status (mode chip + model) + popup + input within a height−2 budget; banner-in-scrollback on startup/switch with transcript reprint (picked sessions show history now); overlays become bounded centered boxes with sliding windows (picker, settings lists); wheel/scrollbar/selection native; pty-verified (no 1049h, scrollback inserts above frame) | d52f53d |
| 2026-09-19 | Mode switching UI: shift+tab cycles permission modes (`perm.Next` + quiet `cycleMode`, no chat notice), Claude-Code-style mode line above the input (per-mode accent, hidden in ask, liveChrome-accounted), bare `/mode` opens an interactive picker (`modepicker.go`) replacing the printed list; `/mode <name>` + settings row unchanged; tests + dump frames | a537a0f |
| 2026-09-19 | Bottom-pinned inline frame: flush tops seal chunks up with blank rows so the input glues to the terminal's bottom edge (Claude Code's full-screen inline look); two-regime pin law (no-scroll fill / scroll self-pin) + one-tick-delayed refill for the height-mismatch case; tmux-verified end to end | (this commit) |
| 2026-09-19 | Fixes from the first pinned run: mouse capture restored (wheel swallowed — Claude Code parity; the wheel must not scroll the scrollback under a full-screen frame) and the header built one column short — flush's alignment prefix was wrapping the rule onto a second row and could push the mode chip off | (this commit) |
| 2026-09-19 | Transient rendering settled after three iterations (pad → pad+drain → fixed band): the chat frame now carries a FIXED 12-row transient band (popup/picker/mode line or blanks) — the frame's height never changes, the same-size repaint erases transients, nothing moves; pad/drain machinery deleted | (this commit) |
| 2026-09-21 | Full-screen rendering: reverted the inline+scrollback experiment after five rounds of renderer artifacts; khode runs on the alternate buffer with an in-app conversation viewport (wheel-scrollable), popup overlays erase cleanly, input pinned at the bottom; all inline printing machinery deleted | (this commit) |
| 2026-09-22 | `/model` picker dialog: bare `/model` opens a centered chooser (cached list + type-to-filter + f fetch/auto-fetch-on-empty, `applyFetchedModels` routes results), `/model <name>` direct-set unchanged, completion row runs bare `/model` at once | (this commit) |
| 2026-09-22 | Fix: `/sessions` + esc quit the app on young sessions — the picker guessed "startup picker" from `len(m.messages) > 1`; the mode is now an explicit `startup` flag (`OpenStartupPicker` for `--resume`, whose esc still quits) so a chat-opened picker always closes | (this commit) |
| 2026-09-22 | `/mcp` servers dialog: sorted per-server rows with live status glyph, tool count (+ session-disabled), risk badge, launch-line detail; enter starts/restarts via `applyMCPCmd` (busy-marked until `applyMCPResult`), space bulk-toggles the server's tools session-scoped; printed `mcpStatus()` removed | (this commit) |
