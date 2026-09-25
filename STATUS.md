# STATUS.md — Progress Tracker

One-glance project state. Update at the end of **every** task (see
`RULES.md`). Historical detail belongs in `MEMORY.md`, not here; the
phase checklist and backlog live in `ROADMAP.md`.

## Roadmap

Lives in `ROADMAP.md` — phases 0/1 through 7 are complete.

## Now

**Automatic new-session context gatherer (2026-09-25):** the first real
prompt of a fresh session now runs a read-only context-gatherer subagent
before the main turn. The UI drives the sweep directly (read/glob/grep
registry, 15-round cap, no approver — nothing it does can ask), renders a
live `◆ gathering context` block with the sweep's latest read plus a
"gathering context" status line, and on completion converts that block into
the same dim `◆ context brief` a resume shows, then starts the answer with
the brief as the runner's preface. Failure never blocks the turn (a dim
"continuing without it" note); esc during the gather stops the whole submit;
the second and later prompts never re-gather (empty-transcript trigger).
`/settings` gains a "gather context" toggle (config `gather_context`, on by
default). Verified in the tmux harness: mid-gather block + status, brief
block, and the injected transcript row all captured live.

**Runner preface (2026-09-25):** `Runner.Preface` writes optional groundwork
(a context-gatherer brief) into the transcript as its own user message
wrapped in `<task-context>` tags, ahead of the user's message — session
truth like any message, replayed to the provider and summarizable by
compaction. On resume, `replayTranscript` renders it as a new dim
collapsible `◆ context brief` block (capped at 4 lines, ctrl+o expands)
instead of a user bubble.

**Subagent activity streams into the TUI (2026-09-25):** a task call's
in-flight child no longer runs invisibly (ROADMAP "Next" #1). The task tool
forwards each child tool call through a new `SubagentConfig.Progress` hook
(non-blocking, drop-on-full), the UI pumps it through the same
`waitForEvents` select as stream events, and the active task call line grows
a dim nested line — `⎿ explore · grep package · 1 calls` — upserted live and
cleared when the report block lands. Verified in a live TTY via the tmux
harness: fakeai now plays an explore-subagent scenario (grep round held
~3s so the line is readable, then the report), mid-flight and final captures
both checked. Sequential tool execution means at most one task runs at a
time, so the UI tracks the active task by index+call id with no agent-side
id plumbing.

**Typed subagents (2026-09-25):** the `task` tool gained `subagent_type` and
`description` parameters and a kind catalog (`internal/agent/subagent.go`):
`general-purpose` keeps the current full-toolset behavior, while `explore`,
`context-gatherer`, and `plan` are read-only profiles (read/glob/grep only —
every call is RiskRead, so plan mode works and no approval dialog can fire)
with per-kind system-prompt sections and report caps (16 KB general, 8 KB
explore/gatherer, 12 KB plan). The user asked for subagent features with a
special new-session context gatherer, polished like mainstream TUIs (Claude
Code's general-purpose/Explore/Plan parity); the gatherer's automatic
first-prompt run, live subagent activity in the TUI, and `subagent_model`
land in the following commits.

**Band rendering fixed (2026-09-25):** the user's screenshot showed the
Grok bands broken two ways, both from SGR stream details: (1) lipgloss
emits SHORT resets (`\x1b[m`) while chroma writes long ones — the reset
re-injection only handled the long form, so the gutter's reset killed
the band and every line rendered first-token-on-black, rest-on-green;
`bandLine` now strips ALL reset forms (regexp `\x1b\[0*m`) and paints
the band once per row — every token sets its own foreground, so resets
are unnecessary mid-line. (2) A diff run ending in a blank line lost
its syntax colors entirely: chroma folds the trailing newline away, the
formatter's output comes back one row short of the run, and
highlightLines' row-count guard fell back to plain — it now pads the
missing blank row back. Band tints darkened to quiet stripes
(#1B4626 additions, #4E2229 removals) after the saturated pass read as
a wall of green on 37-line writes.

**Colorful Grok diffs (2026-09-25):** two fixes to make the write diff
actually read like Grok's. The token palette is now VSCode Dark+ — blue
variables (#9CDCFE), purple control flow (#C586C0), orange strings
(#CE9178), green comments (#6A9955), teal classes, pale-green numbers —
replacing the first aurora mapping that only colored keywords, strings,
and comments and left every identifier at the terminal's default
(monochrome). And the background bands now cover the whole row: the
line is assembled from parts that each reset their own SGR (the
lipgloss gutter, chroma's tokens), so `bandLine` re-injects the
background after every reset along the row — a single injection at line
start only painted the four-character gutter. Band tints brightened to
Grok's saturation (#1A5A2D additions, #5F232D removals).

**Grok-style write diffs (2026-09-25):** the edit/write diff block
dropped its git conventions for the Grok treatment: a dim line-number
gutter (width of the largest number the diff shows, per-hunk numbers
parsed from the `@@` headers — removed lines show old numbers, added
the new), full-width background bands behind changes (dark green
`#17301F` additions, dark red `#3B1D21` removals, padded edge to edge
with the band so rows read as stripes), no `+`/`-` markers and no `@@`
header rows, and the aurora syntax colors riding on top (chroma resets
once per line, so `bandLine` strips that reset and injects the
background SGR — a lipgloss background would be killed mid-line by the
embedded resets). The diff body sits flush left under the ⎿ summary;
the expansion cap now counts pure content lines. Bands are darker than
the foreground palette on purpose so syntax colors stay legible; the
approval dialog's simpler +/- colorizer is unchanged (it has no file
path to pick a lexer with).

**VSCode-style diff highlighting + expandable output (2026-09-25):** the
diff under edit/write results now syntax-highlights the code instead of
painting every line flat green/red — chroma (already glamour's lexer)
lexes the code in the aurora palette (keywords cyan, strings/numbers
amber, comments dim italic, names mint; `internal/ui/highlight.go`) with
the lexer picked by the changed file's extension, run-based so
consecutive same-kind diff lines lex as one snippet and multi-line
comments survive; the +/− markers keep their green/red tint and `@@`
headers stay dim. Tool results and diffs with hidden lines are
expandable: ctrl+o toggles the most recent truncated block between its
summary and its full output (errors expand into a red body under the
bold header), the truncation markers carry "ctrl+o" hints, and the
blocks register click regions — a press anywhere on one toggles it
(viewport lines now carry their message index for region mapping).
Highlighting is deterministic by file extension — content sniffing was
dropped after it highlighted a `.blob` as JavaScript. chroma and
x/ansi moved indirect→direct at unchanged versions.

**Readable tool calls + stray-bar fix (2026-09-25):** tool call lines
read as commands and paths instead of raw JSON — `⏺ bash mkdir -p
khode-test/backend` (multi-line commands flattened), `⏺ read
cmd/main.go`, `⏺ glob **/*.go`; write-class tools keep the path-only
form (their diff block carries the content), plan shows nothing (its
dialog is the feedback), task shows its description, and only shapeless
tools (MCP) keep the compacted JSON; the 120-char truncation cap rose
to 200. Root-caused the "two vertical lines while thinking" report: raw
text mid-stream regularly pauses inside an unfinished markdown
construct (an unclosed code fence, a started list/heading/rule), and
glamour renders that open construct as an empty final row — which the
answer bar painted as a bar-only line directly under the text, reading
as a second vertical rule beside it (every thinking pause between
output bursts re-created it). `renderAnswer` now drops trailing
bar-only rows before painting the bar and cursor, and a whitespace-only
raw renders nothing; structurally, phase switches and seals drop a
streaming block that never said anything (whitespace-only deltas from
some models no longer leave a stray block), and delta updates target
the open streaming block wherever it sits, so activity appended after
it (todo panel refresh, compaction notice) can no longer freeze its raw
into an orphaned half-rendered block.

**Git-style diffs for writes + streaming dedup (2026-09-25):** edit and
write results now render as their git-style change in the chat — the
`⏺ edit <path>` call line (path only; the compacted-JSON args are gone
since the diff carries the content) over a `⎿` block pairing the result
summary with the colorized unified diff (dim `@@` hunks, red `-`, green
`+`, clipped to width, capped at 20 lines with a "… N more diff lines"
tail). The diff is computed from the tool *input alone*
(`tools.ChangeDiff`: edit diffs `old_string`→`new_string`, write shows
its content as additions) — no file access, so it is identical live and
on `--resume` replay (`replayTranscript` pairs call→result by call id
like the todo panel); write-overwrites show all-additions rather than an
old→new diff (the pre-write content is unrecoverable at replay time).
Errored write-class calls keep the plain red result rendering. The same
task fixed the duplicate streaming render: `messageViewport` painted
every in-flight block twice — once in the history loop, again via
`streamingBlock()` at the live edge — so streaming thinking lines (and
answer bars) appeared doubled with stacked vertical bar segments; the
history loop now skips streaming blocks.

**Test isolation fix (2026-09-25):** `go test ./internal/ui` could
overwrite the developer's real `~/.khode/config.json` — `newTestModel`
didn't pin HOME, so tests that reach persisting paths (mode picker
apply, `/mode plan`, shift+tab cycling) wrote their "test"/"test-model"
fixture over the live config, and the persist assertions passed because
they reloaded their own write. `isolateHome(t)` now runs inside
`newTestModel` (HOME → temp dir, provider key envs cleared), verified
by a canary diff across a full suite run.

**Live todo checklist (2026-09-25):** the todo tool now actually drives
multi-step work, Claude Code style. The base system prompt teaches the
workflow (multi-step work keeps a todo list, exactly one item
in_progress, completed items marked as they finish), and an approved
plan hands off to the list — the plan tool's approval result tells the
model to record the plan as todos before implementing. In the TUI, todo
updates render as one checklist panel that upserts in place at the live
edge (call lines suppressed; an empty list clears the panel), styled
☑ done / ❯ in progress / ☐ pending with a done/total title, and the
status line shows the current task plus progress while a turn runs
("working · ❯ wire handoff · 2/5 · 14s"). Resume replays the final
panel by pairing results to todo calls through their call id (mixed
rounds interleave results). Display-only: the transcript still keeps
every todo call and result.

**Turn-hang hardening (2026-09-24):** a khateway 504 used to pin the
turn in silent "working" for ~10 minutes (the user saw 6) and a
mid-stream stall could hang forever. Three bounds now guarantee an
error surfaces: the SDKs' hidden internal retry is off
(`WithMaxRetries(0)` — it doubled every khode attempt), khode's retry
ladder runs under a 45-second wall-clock budget so a gateway that
answers 504 after its own 60s upstream timeout is never retried (fast
transient failures still run the full ladder), and a 90-second stall
watchdog cancels any stream that stops producing events, surfacing
"model stream stalled" instead of blocking forever. `insufficient_quota`
429s (khateway prepaid exhaustion) are never retried. Every retry shows
on the status line ("working · 41s · retry 2/5 · 504 …") via the new
`llm.RetryEvent`, and clears when content flows again. Worst case per
LLM call is now ~90s + backoff, bounded, with the cause visible.

**Chat input + user-message UX (2026-09-24):** user messages ride a
green left rule — the same bar grammar as khode's answers, green where
khode's are teal/cyan — and the background slab is gone entirely:
filled bands are where terminal color degradation bit (the user saw
black-on-green), so user/assistant/system now all render background-
free. The chat input gained shell-style ↑/↓ prompt recall, gated to
the input's first/last line (soft-wrap aware via `LineInfo`) so
multi-line drafts keep moving the cursor between lines; typing is
stashed as a draft and restored by ↓ past the newest entry, consecutive
duplicates collapse, and the buffer reseeds from the transcript on
`--resume`/session switch. Clicking anywhere in the input box now
places the cursor: the box registers one region per visible row and
`internal/ui/input.go` maps the pressed cell back to a logical
line/column through `wrapRunes` — a column-for-column mirror of
bubbles' textarea `wrap()` (the textarea has no mouse support of its
own), `ScrollYOffset`-aware so a scrolled (>6-row) input still maps.

**Every button clickable — mouse + keyboard parity (2026-09-24):** the
TUI now answers left clicks everywhere its footers advertised keys: a
render-time click-region registry (`internal/ui/click.go`, the
scrollbar-geometry precedent generalized — every `View` repopulates
package state with screen-space regions, and the click dispatcher
hit-tests the press against the frame that rendered last). Keycap footer
chips press their key (allow/deny/cycle on the approval and plan
dialogs, enter/esc/f/n/tab/shift+tab across settings, /mcp, /model,
/tools, sessions, the walkthrough, sign-in); list rows follow the
select-then-activate convention (first click moves the ❯ cursor,
clicking the row under it activates — double-click opens); /tools rows
toggle at once (checkbox semantics); form rows focus their field, enum
rows cycle, save rows commit; the /mode picker and completion popup run
their row's action; the header and status-line mode chips cycle the
permission mode; the setup banner's /welcome, /login, and /settings
words run those commands; the sign-in dialog's verification URL opens
the browser; and list windows' "↑/↓ N more" notes page the window.
The welcome walkthrough's custom-provider form gained an explicit save
row (it already had a save cursor position) so mouse users can commit.
Key synthesis is the load-bearing trick: chips and row activation
synthesize `tea.KeyPressMsg`s routed through the factored-out
`handleKey`, so a button and its key stay one code path. Two render
falls-out: `chatView`'s chrome budget now counts the transient band's
rendered rows (not band count — the multi-row completion popup used to
overflow the frame and clip the header), and region math forced exact
mid-band geometry (bottom-anchored, trim-safe). A surface-sweep test
renders all 20 surfaces asserting in-frame regions, and end-to-end
tests click chips and rows through `Update`. Wheel, scrollbar, and
shift-drag text selection are unchanged.

**Setup banner in the chat frame (2026-09-24):** esc-skipping the
walkthrough is still allowed — setup is never a wall — but it no longer
lands in a silently dead chat. While the pre-flight would block a turn
(no resolvable key, or a provider with no model), the chat frame renders
a persistent one-line banner above the input: "khateway not set up ·
/welcome to finish · /login signs in with your browser" (khateway), "no
API key for X · /welcome to finish · /settings → api key" (others), or
the no-model pointer once a key exists. It clears the moment setup
resolves, is clipped to one physical row like the mode hint, and sits
first in the transient band so the completion popup stays glued to the
input.

**Walkthrough: khateway first + /welcome re-run (2026-09-24):** the
first-run walkthrough now treats khateway as the first choice — it leads
the provider list (`khateway, anthropic, openai, <customs>, custom…`)
and the cursor starts on it, with the row hint saying "khode native ·
one account, every upstream model". Esc semantics are now documented and
extendable: esc only dismisses the walkthrough for the session — while
nothing is configured (no key, no custom provider, no model choice) it
reopens on every launch — and a new `/welcome` command re-runs it any
time, so a user who got partway through (or wants to change setup) has a
way back in. Completion popup and /help list it via the shared
slashCommands table.

**Khateway endpoint baked in (2026-09-24):** `DefaultKhatewayEndpoint`
(now `https://khateway.chengsokdara.workers.dev/v1`, confirmed from
~/Apps/khateway's wrangler config + live probe: /health 200, keyless
`/v1/models` → 401) replaced the `localhost:8787` dev default in both
places it is mirrored — `llm.DefaultKhatewayEndpoint` and
`internal/khateway.DefaultBaseURL` (the device-flow client, kept a
standalone duplicate by design). khateway is first-class native: a fresh
install needs zero configuration — pick the provider, `/login`, go —
and `KHATEWAY_BASE_URL` still overrides for local dev. A guard test pins
the default to the deployed https URL.

**Keyless removed — sign-in or a real key (2026-09-24):** the deployed
khateway now rejects every /v1 request without a valid client key (401
invalid_api_key) and its keyless gate is gone, so khode dropped the whole
keyless wire path. `config.KeyOptional` is deleted: khateway needs a
resolvable credential like every provider, and a keyless khateway turn is
stopped by the pre-flight with a pointer to `/login` next to `/settings`.
`llm` lost `khatewayAnonKey`, `khatewayAccessSecret`, and the
`x-khateway-access` header threading (`extraHeaders` params removed); one
construction-only placeholder (`khatewayUnauthenticatedPlaceholder`) keeps
the SDK clients buildable — the pre-flight makes it unreachable on the
wire, and `KHATEWAY_API_KEY` via orEnv still wins. The first-run
walkthrough's khateway path now opens a **khateway access** step (browser
device sign-in — recommended — or paste a portal Keys-page key; no keyless
option), the `/settings` api-key row offers the same two paths, and the
sign-in dialog (`deviceLogin`) is dispatched/rendered above welcome and
settings so it owns the keys while open; esc returns to the choice, and
approval advances the walkthrough to its model step. `scripts/
build-release.sh` no longer injects any secret. Full gate green.

**khateway device sign-in + guest-pool billing (2026-09-24):** khode is
for other people, so keyless needed identity + a ceiling. `/login`
(internal/khateway + ui/devicelogin.go) runs the RFC 8628 device flow
against the gateway: mint → show URL + XXXX-XXXX code (browser auto-opens,
`o` reopens, esc cancels) → poll at the minted interval → on approval bank
the personal API key into auth.json, switch the provider to khateway, and
auto-pick the first listed model. The gateway side granted khateway users
a **guest pool** too: keyless traffic now bills a pool account the
operator funds, so anonymous usage has a hard ceiling (pool at $0 → 429).
Verified against a live dev server (mint + pending poll through the new
client) plus httptest wire tests; go build/vet/test/gofmt green.

**SUPERSEDED (2026-09-24, keyless removed):** the entry below describes
the keyless-gate access secret; the gateway dropped the keyless gate and
khode dropped the secret, the header, and keyless requests entirely.

**khateway keyless-gate access secret (2026-09-24):** official khode
builds can now prove themselves to a gated khateway.
`llm.khatewayAccessSecret` is baked at compile time via
`KHODE_ACCESS_SECRET=<secret> scripts/build-release.sh` (ldflags
`-X khode/internal/llm.khatewayAccessSecret=…`; never committed), and
every khateway request — both SDK faces and `FetchModels` — carries it
as `x-khateway-access` while the `anonymous` key placeholder stays
unchanged. Plain `go build` checkouts leave the var empty and send no
header: against a gateway whose operator turned the keyless gate on
(khateway stores only the secret's sha-256 in `settings`) they get 401
and must set `KHATEWAY_API_KEY`. Wire tests in `khateway_test.go` pin
the header on both faces + model listing and its absence on repo builds.

**Scrollbar cutoff fix (2026-09-23):** the dialog scrollbar showed gaps
because some plan lines rendered wider than the body — glamour applies
list indent *after* wrapping (a packed list line = wrap width + indent)
and chroma code blocks never word-wrap — so the body's pad style wrapped
those lines onto a second physical row that had no gutter glyph, cutting
the bar into segments and desyncing the recorded window height. Three
layers now: plan markdown wraps at `bodyWidth − planWrapSlack` (6 cols
of indent headroom), any line still wider is re-wrapped ANSI-aware
(`wrapOverflow`, reflow/wordwrap), and the body pad carries `MaxWidth`
as the final guard — one logical line is always exactly one physical
row, and a regression test walks every window row asserting the gutter
is present.

**User slab redesign (2026-09-23):** the first slab pass had two real
problems in the live terminal — the text carried no explicit
foreground and fell back to the terminal default (dark, unreadable on
green), and the band painted the full terminal width even for a
three-word message. The slab now hugs the content: text is explicitly
light (`colText` on the band), long lines word-wrap at the chat width
with a two-space hanging indent under the `❯` (reflow/wordwrap, now a
direct dep), and the band width is the widest wrapped line — green
cards, not green wallpaper.

**Scrollbar fixes + mouse interaction (2026-09-23):** three fixes to
the dialog scrollbar from real use. The glyphs are now one family — a
two-cell gutter with a cyan full-block `██` thumb over a light-shade
`░░` track (the old `▐`-next-to-`│` misaligned and read as a broken,
disconnected bar in iTerm2) — and the track brightened to `colDim`
(`colBorder` was nearly invisible on black). The pgdn overshoot bug is
fixed: `scrollPerm` now clamps against the real rendered body height
(`permBodyLines`, shared with the views) instead of a coarse bound, so
pgdn past the end stops at the last window and the very next pgup
scrolls back — before, every extra page piled onto the offset and had
to be unwound. And the scrollbar is interactive: clicking the thumb
grabs it and dragging scrubs the window (motion → offset through the
thumb's travel range), clicking the track pages toward the click,
release ends the grab. Geometry (gutter column, window rows, thumb
span) is recorded by each render into package state the mouse handlers
hit-test against; a `TestPermScrollbarGeometry` test pins the recorded
coordinates to the glyphs the view actually drew.

**Green slab cards for user messages (2026-09-23):** user input now
renders as a full-width dark-green band (`userCard`, `hexUserBg
#123524`) with the bold green `❯` inside it — container vs open prose
against khode's cyan answer bars, so the two are distinguishable at a
glance when scanning a long transcript, not just by a small glyph.
Multi-line input reads as one card: `Width()` pads/wraps every line
onto the band. User text stays raw (no markdown — input is literal).

**Scrollable markdown dialogs + live streaming markdown (2026-09-23):**
both approval dialogs are now scrollable readers instead of 20-line
truncated previews. The plan dialog renders the plan through the same
aurora glamour pipeline as chat prose (`dialogLines` caches the render
per (text, width), so glamour runs once per plan, not per frame), and
the tool dialog shows the full diff (lines clip to the body width so
nothing overflows the box). An overflowing body gets a scrollbar gutter
down its right edge — dim `│` track, cyan `▐` thumb sized ∝ rows/total —
and rows are padded to the body width first so the gutter column stays
aligned across ANSI lines (`perm.go`: `permBodyWidth`/`permBodyRows`,
`dialogWindow`). `permKey` gained scroll keys: ↑/↓ and j/k move a line,
pgup/pgdn a page (the window height), home/end and g/G jump to the ends;
y/n/enter/esc/shift+tab still answer, and the footer gains
`↑↓/pgup/pgdn scroll · home/end jump` hints only while the body
overflows. The wheel scrolls too: the mouse is now captured for the
wheel (`MouseModeCellMotion` on the View) because without mouse
reporting iTerm2 scrolls its own scrollback out from under the alt
buffer — the user could wheel clean out of the TUI, and the dialog
never saw the tick. A wheel tick over an open dialog scrolls its body;
over the chat it scrolls the viewport (`wheelStep` = 3 lines; note the
directions are opposites — `permScroll` counts from the top,
`m.scroll` back from the live edge). Text selection survives through
the terminal's override (shift-drag, option-drag in iTerm2). The offset
lives on `Model.permScroll` and resets whenever a
new question opens the dialog. Streaming assistant text now renders
markdown live (same pipeline as sealed prose, cursor still trailing) —
the raw-plain streaming view is gone. Two latent bugs fell out of that:
`block()` used to cache the streaming render (raw text + cursor), so
mid-turn blocks sealed by a tool call replayed the cursor-trailed body
forever instead of their markdown answer-bar view — streaming renders no
longer populate the cache; and the aurora theme's `Text` color was
overriding heading/blockquote colors (glamour renders plain text as
current-block ⊕ Text, so Text always won) — `Text` now carries no color
and headings actually step green→cyan→mint as the theme always intended.

**Distinct agent-output UI (2026-09-23):** every assistant message now
renders under a left answer bar — dim teal while the turn is still
running, **bright cyan on the turn's final answer** — and sealed prose
goes through a dedicated aurora glamour theme
(`internal/ui/markdown.go`) instead of `WithAutoStyle()`, which
silently degraded to the colorless NoTTY style on terminals where
background detection fails and made the final answer read as gray
wallpaper. Streaming text starts bright and renders the same markdown
live (see the scrollable-dialogs entry above); the seal swaps nothing
but the bar brightness. The glamour renderer is cached per wrap
width instead of rebuilt per message. Tool results got their own
mid-tone (`colResult`) — real content, one step quieter than prose,
clearly apart from the dim-italic thinking/system notes. Per-turn
final answers are marked both live (`markFinalAnswer` on a clean
`finishStream`) and on replay (`isFinalAnswer`: assistant prose with no
pending tool calls followed by the next user message), so `--resume`
looks like the live session; errored turns keep the dim bar (the
failure note is the loud end, not the prose). The palette is now
declared as hex constants that both lipgloss and the glamour theme
share.

**Live mode switching mid-turn (2026-09-23):** mode changes apply to the
running turn immediately. `agent.Runner.Mode` is a `func() perm.Mode`
re-read before every tool call (the same live-closure pattern the plan
and task tools already used over `cfg.PermissionMode`), so shift+tab or
`/mode` while the agent works steers the rest of the turn — switching to
accept-edits/auto stops the asks (subagents included), switching to
plan/ask resumes them. The approval dialog joins in instead of
swallowing the key: `permKey` cycles the mode on shift+tab, and when the
new mode would have allowed the pending call outright
(`perm.Decide(mode, req.Risk) == DecisionAllow`) the dialog answers
itself (`autoResolvePerm`) and the turn continues. Asks the new mode
still poses (bash under accept-edits) or denies (plan mode) stay open
for a manual answer, and plan-approval dialogs are never auto-resolved —
only the allow direction is automatic. The dialog footer shows the
`shift+tab mode` hint.

Phase 7 complete — nothing in khode needs hand-editing config.json.

**Live khateway wiring (2026-09-23):** khode runs against the deployed
khateway — `base_urls.khateway = https://khateway.chengsokdara.workers.dev/v1`
and `models.khateway = deepseek-v4.1-flash-free` in the user config
(no code change; the built-in `DefaultKhatewayEndpoint` stays
`localhost:8787` for local dev, `KHATEWAY_BASE_URL` still overrides all).
Verified through khode's own stack: protocol + endpoint resolution,
anonymous-key auth accepted by the gateway, and a full streaming turn
with usage against a khateway serving a live upstream model. Caveat:
the deployed gateway's single registered model currently 504s — its
kiosapi.com upstream route stalls (glm/deepseek/mimo hang;
`north-mini-code` and `atria-dawn-preview` answer) — and khode's
transient-retry doubles the wait before surfacing it; registering a
live model in the gateway dashboard is the khateway-side fix.

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
and n opens the add form right in the dialog — the same fields and
commit machinery as /settings, made host-agnostic (`formKey`/`commitForm`
take the form and return the outcome flash; `newMCPServerForm` builds
it, `serverFormView` renders it for both surfaces). A committed add
persists, kicks the live reconcile, closes the form, and lands the
cursor on the new row with a ✓ flash; a duplicate name keeps the form
open with a ✗ flash. Statuses render from live state (`m.mcpClients` +
registry prefix scans) every frame; `applyMCPResult` clears the dialog's
busy marks, and the old `mcpStatus()` text is gone.

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
mode row are unchanged. Cycling mid-turn applies immediately — the
Runner re-reads the mode before every tool call, and a pending dialog
auto-approves when the new mode allows it (see live mode switching,
2026-09-23).

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

**SUPERSEDED (2026-09-24, keyless removed):** the entry below —
khateway keyless-native — no longer holds: the gateway rejects keyless
requests, and khode requires sign-in or a real key.

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

Backlog lives in `ROADMAP.md`.

## Changelog

| Date | Change |
|---|---|
| 2026-09-25 | Automatic first-prompt context gatherer: read-only sweep before the first turn of a fresh session, live `◆ gathering context` block → durable context-brief block, failure-safe, esc stops; `/settings` toggle (`gather_context`) | (this commit) |
| 2026-09-25 | `Runner.Preface` injects a `<task-context>` brief message ahead of the user turn; replay renders it as a dim collapsible context-brief block | (this commit) |
| 2026-09-25 | Live subagent activity: task tool forwards child tool calls via `SubagentConfig.Progress`; the task call block upserts a dim `⎿ kind · activity · N calls` line, cleared at the report (ROADMAP Next #1); fakeai plays an explore scenario for the tmux harness | 7c72328 |
| 2026-09-25 | Typed subagents: `task` gains `subagent_type` (general-purpose / explore / context-gatherer / plan) + `description`; read-only kinds run read/glob/grep only with per-kind report caps and system sections | 83ea1d0 |
| 2026-09-25 | `WORKFLOW.md`: the build-and-verify loop written down — plan → implement+tests → live-TTY self-verify (`scripts/tmux-selftest.sh`) → gate → docs; tmux harness usage, fake-model extension, SGR-test lessons, gotchas | (this commit) |
| 2026-09-25 | Self-test harness: `scripts/tmux-selftest.sh` + `scripts/fakeai.py` — khode driven against a scripted fake model in an isolated tmux TTY, frames captured plain + with SGRs; diff features verified live (expand/collapse, both bands, gutter numbers) | (this commit) |
| 2026-09-25 | Band rendering fixed: short-form lipgloss resets stripped so the band covers whole rows (was first-token black), trailing-blank runs keep colors (chroma folds trailing newline), bands darkened to quiet stripes | (this commit) |
| 2026-09-25 | Colorful Grok diffs: VSCode Dark+ token palette (was monochrome — identifiers fell to terminal default) + bands re-injected after every SGR reset so they cover the full row, not just the gutter; brighter band tints | (this commit) |
| 2026-09-25 | Grok-style write diffs: line-number gutter from `@@` headers (old numbers on removals, new on additions), full-width dark green/red background bands instead of +/- markers, headers dropped, flush-left body | d5b6819 |
| 2026-09-25 | VSCode-style syntax highlighting in edit/write diffs (aurora chroma palette, lexer by file extension, run-based) + expandable truncated tool results and diffs (ctrl+o, click regions, red non-bold error bodies) | ec82868 |
| 2026-09-25 | Tool call lines readable (bash command, paths, patterns — JSON only for shapeless tools) + stray-bar fix: unfinished mid-stream markdown constructs rendered bar-only rows; trailing bar-only rows dropped, whitespace-only blocks never seal, deltas target the open streaming block past appended activity | 90f32fb |
| 2026-09-25 | Git-style diffs for edit/write in the chat (`tools.ChangeDiff` from input alone, `kindDiff` block with colorized capped diff, path-only call lines, replay support) + fix: streaming blocks rendered twice per frame (duplicate thinking lines, stacked bars) | 7f40bf8 |
| 2026-09-25 | Test isolation: `isolateHome` in `newTestModel` stops `go test ./internal/ui` from writing the real `~/.khode/config.json` (a fixture clobber shipped in the mode-persist tests); canary-verified | (this commit) |
| 2026-09-25 | Live todo checklist: system prompt + plan-approval handoff drive the todo tool; TUI renders one in-place checklist panel (todo call lines suppressed, empty list clears, id-paired replay) and the status line tracks the current task | e4d8dd9 |
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
| 2026-09-22 | `/mcp` gains n-add: the settings server form is now host-agnostic (`formKey`/`commitForm` take the form + return a flash, `newMCPServerForm`/`serverFormView` shared) and the dialog hosts it — add without visiting /settings; committed adds persist, reconcile live, and land the cursor on the new row | (this commit) |
| 2026-09-23 | Dedicated `ROADMAP.md`: the phase checklist + Next backlog moved out of STATUS.md (which keeps Now + Changelog and points at the new file); doc-sync rule and cross-references updated in RULES/AGENTS/MEMORY/README | f2618dd |
| 2026-09-23 | khode pointed at the deployed khateway via `base_urls` (user config, no repo change); anonymous auth + the khateway↔khode streaming seam verified end-to-end through khode's llm stack; the deployed gateway's one registered model currently 504s on a stalled upstream | (this commit) |
| 2026-09-23 | Live mode switching: `Runner.Mode` is a func re-read per tool call (mid-turn shift+tab/`/mode` applies at once, subagents included); the approval dialog cycles modes on shift+tab and auto-approves when the new mode allows the pending call; exec asks under accept-edits and plan dialogs stay manual | (this commit) |
| 2026-09-23 | Distinct agent-output UI: answer bars (bright cyan on the turn's final answer, dim teal mid-turn), aurora glamour theme with a cached renderer replacing `WithAutoStyle`'s colorless fallback, bright streaming text, mid-tone tool results, per-turn final marking live + on replay; two raw-substring assertions moved to `ansiStrip` | (this commit) |
| 2026-09-23 | Scrollable markdown dialogs + live streaming markdown: plan dialog renders aurora markdown in a scroll window (cached per text+width), tool dialog shows the whole diff; ↑↓/jk line, pgup/pgdn page, home/end jumps, cyan `▐` scrollbar gutter when the body overflows; streaming assistant text renders markdown live (streaming renders no longer populate the block cache — fixes stuck cursors on mid-turn seals); aurora `Text` style drops its color so headings/blockquotes keep their tints (glamour renders text as block⊕Text, Text always won) | (this commit) |
| 2026-09-23 | Mouse captured for the wheel (`MouseModeCellMotion`): the alt-screen "wheel belongs to nothing" assumption was wrong in iTerm2, which scrolls its own scrollback and let the user wheel out of the TUI; wheel now scrolls the open dialog's body or the chat viewport (3 lines/tick), selection via the terminal override (shift/option-drag) | (this commit) |
| 2026-09-23 | User messages render as full-width dark-green slab cards (`userCard`/`hexUserBg`, `❯` inside the band) — green = you vs khode's cyan answer bars, container vs open prose; multi-line input reads as one card | (this commit) |
| 2026-09-23 | Scrollbar fixes + interaction: unified 2-cell glyphs (`██` thumb / `░░` track, brighter track), pgdn overshoot fixed (`scrollPerm` clamps to the real body height — no more frozen bottom until extra pages unwind), and the scrollbar is mouse-interactive (grab+drag scrubs, track click pages, release ends); geometry recorded per render and pinned to the drawn glyphs by test | (this commit) |
| 2026-09-23 | User slab redesign: explicit light text on the band (terminal default rendered dark-on-green), slab hugs content instead of spanning the terminal, long lines word-wrap with a hanging indent under the `❯`; `muesli/reflow/wordwrap` promoted to a direct dependency | (this commit) |
| 2026-09-23 | Scrollbar cutoff fix: plan lines wider than the body (list indent after wrap, chroma code blocks) wrapped onto gutter-less physical rows, cutting the bar — plan markdown now wraps with 6 cols of indent headroom, overflowing lines re-wrap ANSI-aware (`wrapOverflow`), and the body pad has a `MaxWidth` guard; regression test walks every window row for gutter presence | (this commit) |
| 2026-09-24 | khateway device sign-in: `/login` runs the RFC 8628 flow (internal/khateway client + ui/devicelogin.go dialog — mint, show URL+code, poll, bank the personal key into auth.json, khateway active, model auto-pick); gateway now also bills keyless traffic to a funded guest-pool account (hard ceiling on anonymous usage). Wire tests + live probe | (this commit) |
| 2026-09-24 | Keyless removed: khateway needs sign-in (`/login`) or a real key — `config.KeyOptional` deleted (pre-flight stops keyless khateway turns, pointing at /login + /settings), `khatewayAnonKey`/`khatewayAccessSecret`/`x-khateway-access` gone (construction-only `khatewayUnauthenticatedPlaceholder`, `KHATEWAY_API_KEY` still wins), walkthrough gains a khateway access step (browser sign-in vs paste; sign-in dialog dispatched above welcome/settings, esc returns to the choice), settings api-key row offers the same choice, build-release.sh bakes no secret | (this commit) |
| 2026-09-24 | khateway default endpoint baked in: `DefaultKhatewayEndpoint` + `internal/khateway.DefaultBaseURL` now the deployed gateway (`https://khateway.chengsokdara.workers.dev/v1`; localhost:8787 was the dev default) — fresh installs need no config, `KHATEWAY_BASE_URL` overrides for local dev; guard test pins the https default | (this commit) |
| 2026-09-24 | Walkthrough: khateway is the first choice (leads the provider list, cursor starts on it, "khode native" hint); esc-skip semantics documented (reopens every launch while nothing is configured) and `/welcome` added to re-run the walkthrough any time (completion popup + /help) | (this commit) |
| 2026-09-24 | Setup banner: while the pre-flight would block a turn (no key, or no model) the chat frame shows a persistent hint above the input — /welcome, /login (khateway), or /settings pointers; clears on resolve; a skipped walkthrough is no longer silent | (this commit) |
| 2026-09-24 | SUPERSEDED same day (keyless removed): khateway keyless-gate access secret — official builds bake `llm.khatewayAccessSecret` at compile time (`KHODE_ACCESS_SECRET=<secret> scripts/build-release.sh`, ldflags) and send it as `x-khateway-access` on every khateway request (both SDK faces + `FetchModels`); repo builds send no header — a gated gateway answers 401 and they need `KHATEWAY_API_KEY`. Wire tests pin header on/off per build type | (this commit) |
| 2026-09-24 | Every button clickable (mouse + keyboard parity): render-time click-region registry (`ui/click.go`), footer chips synthesize their key through the factored-out `handleKey`, list rows select-then-activate, /tools rows toggle, form fields/enum/save clickable, mode chips + setup-banner commands + sign-in URL + ↑/↓ more notes all click-driven; welcome custom form gains a save row; chatView chrome counts transient rows (fixes header clipping under the multi-row popup); surface-sweep + end-to-end click tests | (this commit) |
