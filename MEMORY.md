# MEMORY.md — Cross-Session Memory & Interrupt Recovery

Purpose: let any agent (or the human) resume work after a gap or an
interrupted session **without re-discovering the project**.

## Recovery procedure (read this first)

If you are starting a session, or recovering after an interrupt:

1. Read `STATUS.md` — phase checklist, "Now / Next / Later", changelog.
2. Read the **Current state** and **Decision log** below.
3. Run these to detect in-flight work:
   ```sh
   git log --oneline -10     # what was last completed
   git status                # uncommitted work = possible interrupt
   go build ./...            # does it even compile right now?
   ```
4. If `git status` shows unfinished edits, treat the uncommitted diff as
   the interrupted task: finish it or split it into a clean commit before
   starting anything new. Ask the human only if intent is unclear.
5. When done with your task, follow the doc-sync protocol in `RULES.md`.

## Current state

- **Working:** Phase 7 complete — khode is configurable entirely from
  the TUI and starts without any API key. Secrets live in
  `~/.khode/auth.json` (`config.Auth`, 0600, atomic temp+rename write);
  env vars beat stored values via `llm.Resolve(provider, storedKey,
  storedURL)`, and `llm.New(name, key, baseURL)` builds either provider
  from explicit credentials (empty values fall back to the SDK env
  lookup). `main.go` has no key gates anymore: with no resolvable key it
  calls `m.OpenWelcome()` — a 4-step walkthrough (intro → provider →
  masked api key → ready card with "enter to start chatting"; esc skips
  any step, shift+tab steps back) — skipped when the `--resume` picker
  is showing. `Model.hasCredentials` blocks submit and /compact with a
  "/settings" pointer instead of starting a turn that would 401.
  `/settings` (`internal/ui/settings.go`) edits provider, api key, base
  url, model, max tokens, mode, MCP servers, and hooks; provider and
  mode cycle with ←/→, text rows open masked `textinput` editors, and
  every commit saves immediately (config via `cfg.Save`, keys via
  `auth.Save`); footer keys render highlighted via `keyHint`. Provider
  switching goes through `switchProvider`, which rebuilds `m.provider`
  and re-registers the task tool (`registerTaskTool`) because
  `SubagentConfig` captured the provider by value; in-flight turns keep
  the old client. Custom providers (`config.CustomProviders`, managed
  in the provider list on the provider row) speak a built-in protocol
  under their own name via `llm.NewProtocol`; `config.Credentials`
  resolves key + base URL (env `<NAME>_API_KEY`/`_BASE_URL` beat stored
  values). The model row opens a picker (`modelPicker`) that fetches
  the endpoint's list with `llm.FetchModels` (off the UI goroutine,
  result via `modelsFetchedMsg`), caches it in `config.ModelChoices`,
  and offers manual add (n)/remove (d); customs never inherit a
  built-in default model, and an empty model blocks turns at the
  pre-flight check. MCP changes apply live: `applyMCPCmd` runs off the UI
  goroutine from `maps.Clone` snapshots, closes removed servers
  (`tools.RemoveMCP`), starts new ones (`mcp.Start` + `tools.AddMCP`),
  and force-restarts edited ones (command/env/risk are fixed at
  `mcp.Start`); results ride `mcpApplyMsg` into `applyMCPResult`, which
  moves clients into `Model.mcpClients` and reports in chat. Hook edits
  apply next turn (a fresh `hooks.Runner` is built per turn). The
  status line shows a context meter (`ctxUsage`/`ctxLabel`): last
  request's input + reply over `llm.ContextWindow`, warning at
  `ctxWarnFrac` (0.8, mirrors compact.go), reset in `useSession`.
  `tools.Registry` has an RWMutex — the agent loop reads it from its
  goroutine while the overlay mutates it. `Model.partial` is a
  `*strings.Builder`; see Gotchas for why.
- **Not yet started:** backlog only — see STATUS.md "Next".

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-09-16 | Go + Bubble Tea stack (like Crush) | user preference; single binary; best-in-class TUI |
| 2026-09-16 | Own `llm.Event`/`Provider` abstraction instead of SDK types | provider-agnostic agent loop; Anthropic + OpenAI without leaking SDKs |
| 2026-09-16 | Channel-based streaming + `waitForEvents` cmd chain | idiomatic bubbletea; no `*tea.Program` coupling |
| 2026-09-16 | JSONL session transcripts in `~/.khode/sessions/` | crash-safe append, trivially resumable; SQLite only if needed later |
| 2026-09-16 | anthropic-sdk-go v1.73 API style | plain struct fields, no `anthropic.F()`; see Gotchas |
| 2026-09-16 | openai-go v1.12 chat.completions streaming for OpenAI | mirrors `anthropic.go` shape; usage via `StreamOptions.IncludeUsage` |
| 2026-09-16 | `--provider` flag instead of config key for now | AGENTS.md mandates wiring on provider add; `config.Provider` + per-provider defaults is the dedicated next task |
| 2026-09-16 | Per-provider `models` map in config (last-used per provider) + built-in defaults (anthropic: claude-sonnet-4-5, openai: gpt-5-mini); legacy single `model` field migrates into it | switching providers must not clobber each provider's chosen model; flags stay session-scoped overrides (`--model` via unexported `override`, cleared by `/model`) |
| 2026-09-16 | Price table keyed by model-name prefixes with longest-prefix match, in `internal/llm/pricing.go` | dated snapshots (`gpt-5-mini-2025-08-07`) resolve to their family; unknown models show no estimate rather than a wrong one |
| 2026-09-16 | Session listing sorts by mtime and skips 0-line transcripts | lexical order never lets a named session be "latest"; empty transcripts made `--continue` land on abandoned sessions |
| 2026-09-16 | Picker is an overlay state on the root Model, not a separate bubbletea Program | keeps the Elm single-Model pattern; esc quits only when no chat is behind (startup picker) |
| 2026-09-16 | Tool calls/results ride the existing `llm.Event` channel; the runner absorbs provider DoneEvents and emits the turn-level Done itself | round boundaries must not end the UI's turn; the waitForEvents pump is unchanged |
| 2026-09-16 | The agent loop owns ALL session writes; the UI never appends | one writer keeps `agent.Session` the single source of truth; failed turns leave a clean transcript |
| 2026-09-16 | Cancellation still appends `tool_result` lines ("interrupted by user") for outstanding calls | Anthropic/OpenAI reject a transcript with unanswered tool calls; pairing keeps resume valid |
| 2026-09-17 | khateway is a built-in provider whose endpoint SHAPE picks the protocol (`llm.KhatewayProtocol`: …/v1/messages base → anthropic client, else openai client) instead of a stored kind | Khateway serves both dialects from one origin, so there is nothing to configure beyond base URL + client key; the openai face also gives the shared `/models` listing |
| 2026-09-16 | Malformed tool input: execute the model's original bytes, persist `{}` | the tool's arg error is the best feedback to the model, but invalid JSON must never fail `Session.Append`'s marshal |
| 2026-09-16 | Glob implemented on stdlib (`**` via recursive segment matching), no doublestar dependency | RULES discourage casual new deps; ~30 lines, fully tested |
| 2026-09-16 | read/glob/grep cap output (2000 lines/2000 chars, 1000 files, 200 matches/20 KiB); grep skips hidden dirs and NUL-byte binaries | a runaway tool call must not flood the model's context window |
| 2026-09-16 | Tools resolve relative paths against the launch working directory; absolute paths pass through | Claude-Code-style ergonomics; real sandboxing arrives with Phase 4 permissions |
| 2026-09-17 | Permission model = 4 modes (plan/ask/accept-edits/auto, default ask) × 3 risk classes (read/write/exec) declared by an optional `RiskClassifier` interface on tools | roadmap-mandated modes; unclassified tools stay read-only, so old/custom tools are safe by default |
| 2026-09-17 | Permission denials are error tool-results fed back to the model, not turn errors | the model can adapt or explain; killing the turn would strand the transcript |
| 2026-09-17 | Approval questions ride a dedicated `agent.Bridge` channel consumed in the same `waitForEvents` select as stream events; replies are buffered `chan bool` | no new pump machinery; a late answer to an abandoned question can never block or leak |
| 2026-09-17 | `startTurn` drains stale bridge requests before each turn | a cancel landing between publish and pump must not open a dialog for a dead turn |
| 2026-09-17 | bash kills the whole process group on timeout (unix: `Setpgid` + `cmd.Cancel` kill(-pid)) | `cmd.Wait` blocks until every pipe writer closes, so an orphaned child would hang the tool |
| 2026-09-17 | Diff is an in-house LCS (common prefix/suffix trim, cell-count cap with coarse fallback) in `internal/tools/diff.go`, no dependency | RULES discourage casual deps; ~150 lines, fully tested, hunk headers match git's zero-count convention |
| 2026-09-17 | `edit` computes (validate + read) separately from writing, and `Previewer.Preview` reuses the compute path | the dialog must never mutate; Exec stays the only writer |
| 2026-09-17 | Project context: AGENTS.md preferred over CLAUDE.md per directory level, ancestors first, 16 KiB cap, re-read every turn | matches how the user's own agents treat these files; the cap keeps a runaway AGENTS.md from eating the window; per-turn re-read means edits apply immediately |
| 2026-09-17 | Retries only before the first forwarded content event, max 4, exponential 500 ms→8 s cap, Retry-After honored (same cap) | a retry after visible output would duplicate it; long fixed waits would freeze the TUI; server hints beat guesses |
| 2026-09-17 | Retry classification lives per provider (`anthropicRetryable`/`openaiRetryable`), shared policy in SDK-free `llm/retry.go` | SDK error types must not leak out of provider files (architecture invariant); both alias `apierror.Error` with `StatusCode` + `Response` |
| 2026-09-17 | `todo` replaces the whole list every call, keeps state in memory only, risk read | full replacement is idempotent and drift-proof (Claude Code style); a UI-only scratchpad doesn't warrant persistence yet; it touches no files so plan mode stays honest |
| 2026-09-17 | Compaction trigger 80% of `llm.ContextWindow`, kept tail ≤ 30%, cut only at user boundaries, summary merged into the first kept user turn | 20% headroom absorbs the next rounds; user-boundary cuts never orphan a tool call; merging preserves role alternation (Anthropic rejects consecutive same-role messages) |
| 2026-09-17 | Summarizer gets the summarizer prompt in the system role and no tools | no extra user turn to break alternation; tool-less requests cannot derail into tool calls |
| 2026-09-17 | `Session.Replace` writes a temp file, syncs, renames | compaction is the first operation that rewrites history; a crash must leave a loadable transcript |
| 2026-09-17 | Compaction failures are non-fatal (turn continues uncompressed) | summarizing is best-effort; the next provider call reports a real error if the history truly cannot fit |
| 2026-09-17 | MCP client is hand-rolled JSON-RPC over stdio in `internal/mcp`, no SDK | the subset khode needs (initialize, tools/list, tools/call) is small; house style avoids casual deps (glob/diff precedents) |
| 2026-09-17 | MCP tools are namespaced `mcp__<server>__<tool>` (Claude Code convention) | collisions with local tools and between servers are impossible; /mcp groups by prefix |
| 2026-09-17 | MCP tools default to exec risk with a per-server `risk` override (read/write/exec) | a remote tool can do anything, so it must be gated like a shell command by default; trusted read-only servers opt into plan-mode usability |
| 2026-09-17 | MCP tool list is a startup snapshot; `tools/list_changed` is ignored | refresh = restart khode; keeps the pump free of notification machinery for now |
| 2026-09-17 | A failing MCP server warns at launch but khode still starts | one broken server must not take the app down; /mcp shows "unavailable" |
| 2026-09-17 | `mcp.Client` is built on `newConn(r, w)` so tests drive the protocol over in-memory pipes; one subprocess test covers real pipes + env | exec pipes in tests are slow and flaky; the seam is 5 lines |
| 2026-09-17 | Subagents run on `NewMemorySession` (Path=="" skips disk in Append/Replace/Name) | subagent transcripts are scratch work; persisting every task call would litter the sessions dir |
| 2026-09-17 | Subagent registry is a fresh `tools.Default` — no task, no plan | no recursion; plan approval is a main-loop dialog contract |
| 2026-09-17 | Subagent config is function-valued (Model/MaxTokens/Mode read per call), shares the main Bridge, and builds fresh hooks | /model and /mode changes apply to tasks spawned later; a subagent's risky call raises the same TUI dialog; user hooks (e.g. a banned-command veto) must apply inside subagents too |
| 2026-09-17 | Task results are capped at 16 KiB with an in-cut truncation marker | a verbose child must not flood the parent's context window |
| 2026-09-17 | The plan tool is read-risk and plan-mode-only; approval switches to accept-edits in the UI (`setMode`), not in the tool | mode persistence is UI/config state; the tool only needs the boolean, and the result text tells the model the new mode |
| 2026-09-17 | Bridge questions carry a `Kind` (tool permission vs whole plan) on one channel | the stale-request drain and dialog plumbing stay single-machinery |
| 2026-09-17 | Hooks run after permission decisions, before execution; post_tool is informational | a denied/declined call never executes, so its hooks must not either; post_tool veto was deliberately left out |
| 2026-09-17 | Hook veto = pre_tool exit code 2, stderr becomes the error; other exits and timeouts are non-blocking | Claude Code convention; a hook must be able to block, but a broken hook must not wedge every turn |
| 2026-09-17 | Hook shells get their own process group killed on timeout (same as the bash tool) | `exec.Cmd.Wait` blocks on output-copy goroutines; a hook's backgrounded child keeps the pipe open |
| 2026-09-17 | API keys live in `~/.khode/auth.json` (0600, atomic rename), not config.json | the config stays shareable; secrets get owner-only perms; env vars still win (`llm.Resolve`) so shell/CI workflows are untouched |
| 2026-09-17 | Missing keys never exit khode; a pre-flight check blocks turns with a pointer to /settings | "run khode" must not require setup, and a keyless turn would only die on a 401 anyway — catch it before spending the request |
| 2026-09-17 | Settings rows save on commit; no staged apply step | matches the `setMode` precedent; nothing to lose and nothing to forget |
| 2026-09-17 | Provider switch rebuilds the client AND re-registers the task tool | `SubagentConfig` captured the provider by value; the ref swap is safe because in-flight turns hold the old provider |
| 2026-09-17 | MCP reconciliation runs in a `tea.Cmd` from `maps.Clone` snapshots; results applied in `Update` | an initialize handshake can take seconds and the UI goroutine must never touch Model-owned maps from another goroutine |
| 2026-09-17 | Editing a running MCP server force-restarts it | a client's command/env/risk are frozen at `mcp.Start`; diff-based start/stop alone would leave the old process serving |
| 2026-09-17 | Registry uses an RWMutex; `Definitions` uses a `namesLocked` helper instead of calling `Names` | settings mutates the map while the agent loop reads; nested RLocks can deadlock when a writer is queued |
| 2026-09-17 | MCP form args/env are space-separated (`strings.Fields`), no quoting | v1 simplicity; documented in the field placeholder |
| 2026-09-17 | First run opens a 4-step walkthrough (intro → provider → key → ready), not settings | dropping a new user into a config form answered "what is this?" with nothing; the walkthrough ends in an explicit "enter to start chatting" so the way out is never in question |
| 2026-09-17 | Esc always skips the walkthrough; empty key still advances | setup must never be a wall — the pre-flight check catches keyless turns later |
| 2026-09-17 | `switchProvider` is shared by /settings and the walkthrough; `saveSettings` flashes whichever overlay is open | both flows must behave identically and neither should nil-deref the other's overlay |
| 2026-09-17 | Context meter = last request's input + its reply, over `llm.ContextWindow`; warning at `ctxWarnFrac = 0.8` (mirrors compact.go) | input tokens of the last call ARE the transcript size the provider saw; the exact next-turn count is unknowable client-side, this is the honest approximation |
| 2026-09-17 | `ctxUsage` returns (pct, warn, ok) separately from `ctxLabel`'s styling | lipgloss renders plain text without a TTY, so tests must assert the decision, not the ANSI |
| 2026-09-17 | Custom providers reuse the built-in wire protocols (`llm.NewProtocol(kind, name, …)`); only name resolution moved to config | an OpenAI-compatible endpoint IS an OpenAI client — protocol support should not be duplicated per provider |
| 2026-09-17 | Credential resolution lives in `config.Credentials`, not llm | it needs Auth + CustomProviders + env names together; llm stays SDK/config-free and keeps only constructors |
| 2026-09-17 | Custom provider env overrides derive from the name (`GROQ_API_KEY`), uppercased with non-alphanumerics flattened | consistent rule beats a config field per provider; built-ins keep their canonical vars |
| 2026-09-17 | Customs never inherit a built-in default model; `Model()` returns "" and the pre-flight blocks | requesting claude-sonnet from an Ollama box is worse than a clear "set a model" message |
| 2026-09-17 | Model picker auto-fetches only for custom providers; built-ins with no cached choices keep the free-text editor | typing a model name must stay the zero-setup path; auto-fetching api.anthropic.com on every settings visit is surprise network I/O |
| 2026-09-17 | Fetched model lists cache in `config.model_choices` (capped 500) and persist | the list survives restarts, doubles as the manual-entry store, and its first entry is the fallback model |
| 2026-09-17 | The walkthrough's provider step includes configured customs plus a 'custom…' inline add form | key-less Ollama users were walled out of onboarding by a two-provider cycle; the form activates the provider and the key step becomes skippable |
| 2026-09-17 | Walkthrough trigger = no key AND no custom providers AND no model choices | any setup evidence means "not first run", or a keyless Ollama user would see the walkthrough every launch |
| 2026-09-17 | Provider names keep the casing they were saved with; provider-keyed lookups (custom providers, models, choices, auth keys) fall back to case-insensitive matching via `config.providerKey`, and Load snaps the active name to the stored custom-provider key | Load used to lowercase the provider field, splitting "KiosAPI" from its map keys — the name resurfaced as the unknown protocol "kiosapi" and khode died at startup |
| 2026-09-17 | An unknown protocol at startup warns on stderr and falls back to the anthropic client instead of `fatal` | one broken config entry must not brick the app (same principle as a failing MCP server); /settings → provider is where the entry gets fixed |
| 2026-09-17 | Mouse capture is OFF at startup; alt+m toggles it on for wheel scrolling; pgup/pgdn always scroll | while the app reports mouse events the terminal hands every drag to the app and native selection/copy-on-select dies — selectable text is worth more than wheel scrolling; the toggle and keyboard scrolling keep both reachable |
| 2026-09-17 | Thinking rides a dedicated `llm.ThinkingDeltaEvent` and is stored on the assistant message (`thinking` session field) for display only — providers never replay it | Anthropic thinking blocks need signatures khode doesn't keep; echoing reasoning back as content would confuse models; resume display only needs the text |
| 2026-09-17 | OpenAI-protocol reasoning is harvested two ways: DeepSeek-style `reasoning_content` read from the delta's raw JSON, plus a stateful `<think>` splitter over content deltas (holds trailing tag fragments across deltas) | openai-go v1.12 doesn't model `reasoning_content`; DeepSeek/Ollama/proxies inline the tags, often split mid-tag by chunk boundaries |
| 2026-09-17 | Assistant history replay strips `<think>` tags (`llm.StripThinkTags`) in both providers | transcripts written before thinking was split carry the tags in Content; replaying them would resurface reasoning as answer text |
| 2026-09-17 | The walkthrough has a model step (between key and ready) whenever the chosen provider has no model yet: it auto-fetches the endpoint's list and the user picks on the spot; failure degrades to the old /settings pointer | "choose khateway and use right away" must not dead-end into a /settings detour; customs (Ollama) get the same benefit for free; `Config.Model()` falls back to the first cached choice, so a successful fetch also unblocks the pre-flight |
| 2026-09-17 | `modelsFetchedMsg` routes to whichever consumer is open — settings picker first, then the walkthrough's model step; results for neither are dropped | one fetch machinery, two consumers; the stale-drop rule keeps a closed overlay from being mutated |
| 2026-09-17 | Debug logging is gated behind `--debug`: main points the standard logger at `khode-debug.log` via `tea.LogToFile`, code logs through `internal/debug.Printf` (no-op unless enabled) | writing to the terminal from inside a bubbletea program corrupts the alt screen; a file sink is the only safe target, and the gate keeps stray log calls harmless in production runs |
| 2026-09-17 | khateway is keyless-native: `config.KeyOptional` exempts it from the pre-flight key check (submit + /compact) and the walkthrough skips its key step; with no key configured, requests carry the `anonymous` placeholder credential set at client construction | the user wants choose-and-go with zero setup, and the gateway fronts upstream auth itself; `KHATEWAY_API_KEY` / a stored key stay as overrides for gateways that enforce client keys — the gateway side is expected to treat auth as optional |
| 2026-09-17 | The keyless placeholder lives in `llm.NewProtocol`'s khateway branch, not the UI | both SDKs need a non-empty credential: anthropic-sdk-go refuses to build ANY request client-side (`NoCredentialsError`) without one — even against a keyless custom base URL — and openai-go silently sends `OPENAI_API_KEY` as the bearer, leaking an unrelated key to the gateway |
| 2026-09-17 | khateway is select-only: `config.ManagedEndpoint` locks its endpoint — the base-url row is read-only for it (displays env override → stored → built-in default), enter on the row explains `KHATEWAY_BASE_URL` instead of opening the editor, `commitEditor` refuses as defense in depth, and the provider list only ever selects built-ins (d already refused) | khateway is khode's own native integration, not a user-defined endpoint; repointing it at an arbitrary origin from the TUI is a misuse the UI must not offer — environment (`KHATEWAY_BASE_URL`) is the supported way to run a gateway elsewhere |
| 2026-09-18 | One design system in `styles.go` ("aurora"): cyan = khode's own activity, green = good, dim teal-gray = secondary, red/amber only for error/context pressure; every view draws colors from there | the request asked for green+cyan, modern, and "everything consistent together" — semantics fixed per color keep the palette readable, not decorative |
| 2026-09-18 | Footer key names render as keycap chips (`keyHint`), overlay titles through `dialogTitle`, save notes through `flash`; the header wordmark is the only gradient (`logo()`) | keys must be findable without shouting, and reserving the gradient for the wordmark keeps it a signature instead of wallpaper |
| 2026-09-18 | The status line's elapsed timer has no dedicated ticker — `m.turnStart` is read in `statusLine`, and the always-running spinner tick (Init → TickMsg chain) re-renders View ~12×/s | bubbletea re-renders the whole View on every msg, so the free spinner clock animates the timer; no new timer machinery to start/stop per turn |
| 2026-09-18 | View-frame verification: `TestDumpViews` renders every surface into `DUMP_DIR` (raw + ANSI-stripped); `script(1)`/`expect` pty capture produces zero child output even for a minimal bubbletea app in this sandbox | the existing wire-level evidence can't show layout; rendered-frame dumps exercise the real View code and are skipped without the env var |
| 2026-09-18 | Slash completion runs off one `slashCommands` table in `internal/ui/complete.go`: the popup prefix-filters it (exact match promoted to front) and `/help` renders it; aliases are ordinary rows | two lists had already drifted (`/config` worked but help never mentioned it); a table with a `desc` per entry makes a new command a one-line change that surfaces everywhere |
| 2026-09-18 | Popup keys sit between the overlay guards and the root key switch in `Update`: it consumes ↑/↓/ctrl+p/ctrl+n/tab/enter/esc, everything else falls through to the textarea whose update re-filters via `syncPopup`; enter on an argument-free command fills AND submits at once, fill-only while streaming | letters must reach the textarea because the user is typing the query; run-on-enter is the Claude-Code-style "easy" behavior, and the streaming exception preserves the rule that nothing submits mid-stream |
| 2026-09-18 | `/tools` toggles are session-scoped state on the Registry (`disabled` map, `SetEnabled`/`Enabled`), never config: `Definitions()` filters disabled tools and `execCall` rejects calls with "the user turned it off in /tools" | config.json must stay shareable, and the panel is a runtime control like Claude Code's; filtering Definitions alone isn't enough because a hallucinated call to a hidden-but-registered tool would still execute |
| 2026-09-18 | Input newline is labeled shift+enter (the standard) and the binding lists both shift+enter and alt+enter; on terminals that don't report modified keys (bubbletea v1 parses no kitty/CSI-u) a physical shift+enter still submits and alt+enter does the newline | the user asked to follow the standard; the label is honest for anyone whose terminal maps shift+enter → ESC+CR (Claude Code's /terminal-setup does this for Terminal.app/iTerm2, one line in kitty/Ghostty config), and the extra binding fires for free the day bubbletea v2 lands. The mechanics live in the comment at the binding |
| 2026-09-18 | Mouse capture is permanently on (WithMouseCellMotion at program start; wheel → viewport). The wheel-scroll-away "trapdoor" is what consuming wheel events fixes, and the reference TUIs (Claude Code, opencode — user-verified) enable mouse tracking for exactly that. Text selection survives everywhere via shift+drag, the terminals' override for mouse-reporting apps; Terminal.app also has View > Allow Mouse Reporting (⌘R) | capture and native drag-select are mutually exclusive — consuming the wheel is the more valuable half, and the shift override keeps selection reachable; a user toggle was tried twice and removed both times (bad keys, redundant with pgup/pgdn) |
| 2026-09-19 | Inline rendering: sealed blocks print via one `tea.Println` chunk **the moment they seal** (user msg at submit, tool call/result as they land, thinking at the thinking→text switch, answer + error notice at `finishStream`); the live region renders only `messages[printed:]` (in-flight streaming blocks), tail-clipped to the budget | a long agentic turn must not pile up in the redrawn region (the renderer clips frames taller than the terminal), and streaming tool activity out mid-turn is the Claude-Code behavior; flush replaces renderAll mechanically at every former append site |
| 2026-09-19 | Banner-in-scrollback: `header()` prints once via the `printBannerNext` flag on the first flush after `New`/`useSession`; the status line absorbs the mode chip + model (yielding model, then token counts, on narrow terminals); the in-frame header is gone | user choice between banner and persistent header; mode visibility survives via the status line because a mode the user can't see is a safety hazard |
| 2026-09-19 | The restored transcript prints on the **first WindowSizeMsg**, not at boot | glamour/markdown blocks need the real wrap width before rendering; `flush()` no-ops at width 0 and the first resize returns the flush cmd |
| 2026-09-19 | Mouse capture is retired outright and wheel/pgup/pgdn forwarding with it | inline history IS terminal scrollback — with no viewport there is no consumer for captured wheel events, so the three-iteration capture saga dissolved with the alt screen; wheel/scrollbar/selection are native |
| 2026-09-19 | `useSession` now replays the transcript (`replayTranscript`, extracted from `New`) and its callers flush | picked sessions showed only a banner with no history — the inline print path fixes the gap for free |
| 2026-09-19 | Live region budget: whole frame ≤ `height−2` (`liveBudget`/`liveChrome`; popup rows clamp inside `popupHeight`, overlays are bounded boxes via `listWindow`/`listMaxRows`, perm preview capped at 20) | bubbletea v2's `insertAbove` garbles a frame that fills the terminal exactly, and the renderer drops the top of taller frames; the −2 slack keeps printing safe at any budget floor |
| 2026-09-19 | `flush()` clears `rendered` caches of printed blocks and never re-renders them; the chunk goes into `lastPrint` (test seam) | printed history is terminal-owned (a resize can't re-wrap it), so caching it is wasted memory; tests assert `lastPrint`/`printed` instead of scraping terminal output |
| 2026-09-19 | shift+tab cycles permission modes forward through the `Modes()` ladder (`perm.Next`, wraps plan→ask; `cycleMode` persists but appends NO chat notice) | repeated notices would spam scrollback (the settings `applyMode` precedent); the mode line above the input is the feedback. Safe mid-turn: the in-flight turn keeps its `Runner` mode snapshot, and the key only reaches the root switch when no overlay is open (welcome/settings keep shift+tab) |
| 2026-09-19 | The mode line (`⏵⏵ mode · description · shift+tab to cycle`) hides in the default ask mode and tints per mode inside the fixed palette (plan cyan / accept-edits green / auto amber); its row and the mode-picker's are both counted in `liveChrome` | ask is home and the status chip always carries the mode (Claude Code also only shows the indicator in non-default modes); the aurora semantics already decided which colors exist, and an uncounted row would overflow the height−2 frame budget |
| 2026-09-19 | Bare `/mode` opens an interactive picker (`internal/ui/modepicker.go`, the cmdPopup grammar: ↑/↓/enter/esc, floats above the input) instead of printing a list; enter applies via `setMode` WITH the chat notice, unlike `cycleMode` | an explicit selection is a one-off action worth a transcript record, while cycling is repetitive; the completion popup already owns the above-input float and its key handling slots into the same guard chain |
| 2026-09-19 | The inline frame is bottom-pinned (Claude Code's full-screen look): flush appends blank rows to each seal chunk so `top + K + frameHeight` lands exactly on the terminal bottom; the scroll regime (chunk bigger than the dead space) re-pins by itself, and a seal that coincides with a frame-height change is healed by a refill one render tick later (`pinTick`); Update's wrapper mirrors uv's re-anchoring (growth scrolls + keeps the bottom glued, shrink defers to the refill) | the user wanted Claude Code's full-screen inline UI, not a floating box under the banner; the fill must ride the chunk's own insertAbove (a separate Println races and its rows get scrolled away), and the math came from reading `cursed_renderer.insertAbove` plus tmux capture-pane ground truth |
| 2026-09-19 | Terminal-forensics toolchain for renderer work: `TEA_TRACE=/path` makes bubbletea v2 log every write ("insert above:" / "output:") — no WithLogger option exists in v2.0.9; tmux (installed) + `capture-pane -p` / `-S -N` is the ground-truth screen+scrollback emulator; pyte mis-parses kitty keyboard sequences (stray `1u` garbage rows) and screen(1) hardcopy writes empty files here — trust tmux, use pyte only for coarse layout | reading insertAbove alone gave three wrong mental models; the decoded trace pinned the exact cursor math (`CSI nB`/LFs/`CSI nA`/`CSI nL`) and tmux confirmed the rendered result |
| 2026-09-19 | Mouse capture is back under the pinned frame (MouseModeCellMotion on the View, wheel events swallowed inert) — reversing the inline-rework removal one day later | the user explicitly reported wheel-scrolling the scrollback as a bug once the frame went full-screen: "nothing for captured wheel events to scroll" stopped being true when the app started owning the whole terminal; Claude Code consumes the wheel the same way; selection survives via shift+drag, history via the scrollbar and terminal search |
| 2026-09-19 | Everything handed to tea.Println is built ONE column short of the terminal width | flush prefixes every printed line with a space (left-edge alignment with the live region); a full-width rule or header row becomes width+1 and wraps its last character onto a second row — the user-visible "two-row rule / chip overflow" bug |
| 2026-09-19 | Transient ghosts (popup/picker boxes staying painted in the transcript) are fixed with a shrink-absorbing blank pad on the chat view: Update's wrapper grows `padRows` by the frame's shrink delta (chat views only, capped at `maxPadRows`=12), keeping the total frame height constant so uv's same-size repaint ERASES the transient's pixels; growth consumes the pad first | uv's diff renderer never erases rows the frame vacated and exposes no erase-above primitive — keeping the frame from ever changing height is the only way to erase; the pad slot gets reused by the next transient so the cost is temporary |
| 2026-09-21 | The transient band renders the last ~11 lines of REAL history (40-line tail buffer in flush; only displaced lines print to scrollback) and the popup overlays the window's bottom — never blanks. The frame floats under its content at boot (NO blank bottom-pin filler: that filler was the user's "huge vertical gap") and pins naturally when the conversation fills the screen; bandExtra grows the band into overlay dead space, absolutely capped by kept tail lines (an increment-only cap diverges when the tail runs out) | the user rejected the blank band; overlaying real history inside the frame is the only place uv's diff can erase, and it is exactly Claude Code's overlay-the-transcript behavior |

## Gotchas & lessons learned

- **anthropic-sdk-go ≥ v1.73**: no `anthropic.F()` wrappers, no
  `NewUserTextMessage`. Use `MessageNewParams{...}` plain fields,
  `anthropic.NewUserMessage(anthropic.NewTextBlock(s))`, and
  `stream.Current().AsAny()` type switches (`ContentBlockDeltaEvent` →
  `ev.Delta.AsAny().(anthropic.TextDelta)`).
- **glamour v1.0.0**: `glamour.NewRenderer` was removed → use
  `glamour.NewTermRenderer(...)` with the same option names.
- **bubbles v2 / bubbletea v2 (charm.land/*, migrated 2026-09-19)**:
  `View()` returns `tea.View` (alt screen + `MouseModeCellMotion` are
  declared on it, not program options); keys are `tea.KeyPressMsg` with
  `Code`/`Text`/`Mod` — no `KeyRunes`/`KeyCtrlC`; match via `String()`,
  where space is `"space"`, pgdn is `"pgdown"`, and `"enter"` never
  matches a modified enter; v2 speaks the kitty keyboard protocol
  automatically (shift+enter arrives as a real key on supporting
  terminals); `Style.Render()` emits truecolor unconditionally —
  downsampling happens at write time through a colorprofile.Writer (the
  dump harness needs no profile override); textarea/textinput default
  to a *virtual* painted cursor (`Cursor()` returns nil unless you opt
  into a real one); field reads became methods (`Width()`,
  `Height()`, `YOffset()`).
- **v2 textarea sizing**: with `DynamicHeight`, the textarea resizes
  and re-clamps its internal scroll offset inside its own Update pass —
  never drive its height from outside (a stale-but-valid offset pins
  the cursor row to the top of the later-grown box, hiding typed text
  above an end-of-buffer row). Caveats: `MaxHeight` doubles as an input
  block at MaxHeight logical lines when `MaxContentHeight` is 0 — set
  `MaxContentHeight` high to keep long messages scrolling like v1;
  `splitLine`/newline does not call `recalculateHeight` directly, it
  runs at the end of Update.
- macOS terminals compose characters with option by default — option+m
  types µ and no alt key event is generated — so alt+letter bindings
  never fire on default Terminal.app/Ghostty/kitty/iTerm2 setups. Any
  primary binding must be a ctrl key. alt+enter survives because
  option+return has no composed character. (The mouse-capture toggle
  this rule came from no longer exists: capture is now permanently on
  — see Decisions 2026-09-18.)
- expect(1) CAN drive the real TUI after all: the "zero child output"
  noted on 2026-09-18 was bubbletea never receiving its
  `WindowSizeMsg` — expect's pty has no size, so the app paints
  "starting…" forever. Fix: `stty rows 30 columns 100 <
  $spawn_out(slave,name)` right after `spawn` (any resize → SIGWINCH
  also works). Anchor sends on frame text ("welcome to khode" → esc →
  "ready") rather than sleeps; verifed end-to-end for the slash popup.
- glamour renders final markdown only after streaming completes; during
  streaming we show wrapped plain text (perf).
- `viewport` does not wrap lines — every block is wrapped explicitly with
  a `lipgloss` `Width()` style before it enters the viewport.
- Rendered-block cache must be invalidated on `tea.WindowSizeMsg`
  (`invalidateRendered`) or resize shows stale widths.
- **openai-go v1.12**: use `MaxCompletionTokens` (not the deprecated
  `MaxTokens`); usage totals only arrive when
  `StreamOptions.IncludeUsage: openai.Bool(true)` is set, on a final
  chunk whose `Choices` is empty; message helpers are
  `openai.SystemMessage/UserMessage/AssistantMessage`.
- **openai-go `NewClient()`** reads both `OPENAI_API_KEY` and
  `OPENAI_BASE_URL` from the env — OpenAI-compatible endpoints work with
  zero extra code (verified against a local fake SSE server).
- Provider tests: the HTTP request is issued by `Stream`'s goroutine, so
  assert the captured request only AFTER draining the event channel;
  asserting earlier races with the handler.
- `anthropic-sdk-go` honors `ANTHROPIC_BASE_URL` — the fake-SSE test
  points it at an `httptest.Server`, same trick as `OPENAI_BASE_URL`.
- **stdlib `flag` + optional flag values**: bare `--resume` calls
  `Set("true")` on a custom `flag.Value`; `--resume=<name>` passes the
  name. A session literally named "true" needs the `=` form.
- `os.UserHomeDir()` respects `$HOME` on unix, so config tests do
  `t.Setenv("HOME", t.TempDir())` — no path-injection plumbing needed.
- **anthropic-sdk-go v1.73 tools**: `MessageNewParams.Tools` takes
  `ToolUnionParam{OfTool: &ToolParam{...}}` (not a bare ToolParam). Block
  helpers: `NewToolUseBlock(id, input, name)`, `NewToolResultBlock(id,
  content, isError)`. Tool inputs stream as `input_json_delta`
  (`InputJSONDelta.PartialJSON`) keyed by content-block index; the id and
  name come from `ContentBlockStartEvent.ContentBlock.AsAny().(ToolUseBlock)`.
- **openai-go v1.12 tools**: assistant tool calls serialize via
  `ChatCompletionMessageParamUnion{OfAssistant: &ChatCompletionAssistantMessageParam{
  ToolCalls: ...}}` (content alongside via the `Content` union's `OfString`).
  Tool results: `openai.ToolMessage(content, toolCallID)`. Streaming tool
  calls arrive as fragments in `choice.Delta.ToolCalls` keyed by `Index`
  (id/name may arrive split across chunks) — accumulate, emit at stream end.
- **`json.Marshal` fails the whole struct** if a `json.RawMessage` field
  holds invalid JSON — that's why tool inputs are sanitized before
  persistence (a model CAN emit malformed tool-input JSON).
- `encoding/json` matches fields case-insensitively on load, so pre-tag
  transcripts (`"ID"`) still load after adding snake_case tags.
- Verifying a bubbletea alt-screen TUI through `script(1)` is unreliable
  (typescript captures little); the reliable E2E evidence is wire-level
  (fake SSE server logs the request bodies) plus the session JSONL file.
- **`exec.Cmd.Wait` waits for the output-copy goroutines**, which only
  finish when every writer of the pipe closes — kill the direct child and
  a backgrounded grandchild (`sleep 30 &`) still hangs the tool. Own
  process group + `kill(-pid, SIGKILL)` is the fix; `cmd.Cancel` (Go
  ≥ 1.20) is where to put it, returning nil so `Wait` proceeds normally.
- **bubbletea `Update` has a value receiver**: calling `m.Update(msg)`
  without capturing the returned `tea.Model` silently discards all state
  changes — always `m = next.(Model)`.
- `context.WithTimeout` distinguishes the two kill paths: parent cancel →
  `ctx.Err() == context.Canceled` (user interrupt), deadline →
  `context.DeadlineExceeded` (tool timeout). Check Canceled first;
  `errors.Is(DeadlineExceeded, Canceled)` is false, which is what keeps
  the loop's "interrupted by user" wording from swallowing timeouts.
- **Both SDKs alias their own `apierror.Error`** (`anthropic.Error`,
  `openai.Error`) with `StatusCode int` and `Response *http.Response` —
  the Retry-After source. They are distinct types, so classification
  helpers are duplicated per provider file, sharing only the SDK-free
  policy in `llm/retry.go`.
- The SDKs retry the initial HTTP request themselves (default 2), so a
  fake-server retry test cannot assert exact request counts — assert
  "at least the retry" and eventual success instead.
- `NewStreaming` on BOTH SDKs returns a single value (the stream), no
  error — failures surface via `stream.Err()` after iterating. Retry
  loops therefore wrap the whole attempt, not the call.
- To simulate a mid-stream failure in tests: write real SSE deltas, then
  `http.Hijacker.Hijack()` and close the connection — the client gets a
  truncated body (`stream.Err() != nil`) after content was forwarded.
- **`gofmt -l .` exits 0 even when it lists files** — `gofmt -l . && git
  commit` happily commits unformatted code. Use `gofmt -l .` output
  (empty = clean) or `test -z "$(gofmt -l .)"`.
- Cutting injected text to a byte cap must reserve room for the
  "(…truncated)" marker inside the cut, or the output exceeds the cap
  you just asserted.
- **`io.Pipe` is unbuffered and synchronous**: a write blocks until the
  other side reads. The MCP tests hung the whole run because the client's
  initialize write happened before the fake server's reader goroutine
  started — always `go serve()` BEFORE the handshake in pipe-based tests.
- `exec.Cmd.Wait` blocks on output-copy goroutines, and the hook's
  `sleep 30` inherits the stdout/stderr pipe write end — killing bash
  alone leaves `Wait` hanging until the child exits. This re-bite in
  hooks is why the process-group kill lives in both `tools` and `hooks`.
- A struct field typed `any` (e.g. `rpcMsg.Params`) unmarshals JSON
  objects as `map[string]any`, not `json.RawMessage` — tests that want
  the raw bytes must re-marshal.
- Renaming config-file schema: `encoding/json` promotes embedded-struct
  fields, but here MCP server / hook types live in `config` itself (wire
  types belong to the config file schema, matching the `MCPServer`
  precedent); packages take what they need (`hooks.New(config.Hooks, …)`).
- **`strings.Builder` must not be a value field of a bubbletea Model.**
  Model is copied through `Update`'s value receiver, and a used Builder
  panics ("illegal use of non-zero Builder copied by value") when a
  later copy writes — whether that happens is decided by escape analysis
  aliasing, so the SAME code passed at HEAD and panicked after adding
  three unrelated fields. Use `*strings.Builder` (initialized in `New`).
- `t.Setenv("VAR", "")` sets the variable to empty (not unset);
  `os.Getenv` returns `""`, which is exactly what the llm.Resolve
  precedence check treats as "no env override" — tests rely on this.
- **bubbles v1.0.0 textarea paints the focused cursor line with a hard
  background** (`Background(AdaptiveColor{Light: "255", Dark: "0"})`,
  emitted as `\x1b[40m` on dark themes) — on any dark terminal theme
  the whole inside of the chat input box renders as a black strip.
  Override `ta.FocusedStyle.CursorLine` / `ta.BlurredStyle.CursorLine`
  with `lipgloss.NewStyle()` right after `textarea.New()`.
- **Mouse reporting vs text selection are mutually exclusive in a
  terminal**: once the app emits mouse-enable escapes, EVERY drag goes to
  the app (the terminal never starts a selection). `tea.WithMouseCellMotion`
  therefore kills copy-paste for the whole session; enable mouse at
  runtime with the `tea.EnableMouseCellMotion()` / `tea.DisableMouse()`
  commands instead of the program option when the app must support both.
- **openai-go v1.12 has no `ReasoningContent` on the chat delta**
  (DeepSeek/OpenRouter extension): the SDK keeps each delta's raw JSON
  (`Delta.RawJSON()`) and lists unknown keys in `Delta.JSON.ExtraFields`,
  so gate on the ExtraFields entry and unmarshal the raw bytes into a
  one-field struct — verified end-to-end against a fake SSE server.
- **An indexer-style "hold trailing tag fragments" splitter must emit
  `s[:keep]` unconditionally**, not only when `keep < len(s)` — when no
  hold happens keep IS len(s), and gating the write silently drops the
  whole delta. Also mind the classic `Update`-return trap: a
  bubbletea helper that "seals the old block" on a kind switch must fall
  through to appending the new block, or the caller's `messages[idx].raw`
  write lands back on the sealed block.
- **`fmt.Sscanf` with `%02x` cannot scan into `*float64`** — the scan
  errors and a helper that degrades on parse failure (e.g. the wordmark
  `gradient`) returns its input UNSTYLED, silently. Scan into ints, then
  convert. The dump harness pins gradient output so this can't regress.
- **lipgloss rounds hex colors through colorful when rendering**
  (`#2DD4BF` → SGR `44;211;191`), and `go test` output strips color
  entirely unless `lipgloss.SetColorProfile(termenv.TrueColor)` is
  called — so never assert exact RGB channels in output; assert that
  `38;2;` escapes exist (with the profile forced) or check the
  ANSI-stripped layout.
- In `go test`-land, any helper that calls `m.Update(tea.WindowSizeMsg{…})`
  WITHOUT capturing the returned model (`m = next.(Model)`) leaves
  `m.width` at 0 and `View()` returns "starting…" — the same value-
  receiver trap as the gotcha above, one level up.
- **bubbletea v2 `tea.Println` facts (verified in v2.0.9 source, the
  inline rework depends on all of them):** each `printLineMessage`
  becomes `insertAbove` — ONE immediate write that scrolls the screen,
  `InsertLine`s blank rows above the frame, writes the lines, and
  resets cursor tracking to frame-relative. The renderer keeps no
  buffer of printed lines (the terminal owns them; frame repaints never
  erase them, and they scroll away naturally). The doc comment says
  "if the altscreen is active no output will be printed" but v2.0.9 has
  no altscreen guard — under altscreen the math would garble, so treat
  Println+AltScreen as unsupported. If the frame fills the terminal
  exactly, the scroll pushes the frame's own top lines into scrollback
  (transient garble until the next repaint) — hence khode's height−2
  budget. Println batches: one joined chunk per flush, not one println
  per line.
- **v2 inline (no AltScreen) rendering:** the frame is exactly the
  `View.Content` line count (a trailing `\n` adds a blank row — v2
  counts it, v1 stripped it); frames taller than the terminal get their
  top lines DROPPED (`cellbuf.Lines = Lines[frameHeight-height:]`), and
  view lines wider than the terminal are truncated, not wrapped
  (`NewStyledString` has Wrap=false) — pre-wrap everything, which
  khode's explicit `Width()` styles already did. There is no
  WithAltScreen program option in v2 (declare `View.AltScreen`), no
  scroll commands (`ScrollUp`/`ScrollToEnd` don't exist), and no
  renderer-side trimming of printed lines. Quit leaves the final frame
  plus all printed scrollback on screen (graceful shutdown flushes one
  last render).
- **shift+tab is safe as a primary binding under bubbletea v2**: legacy
  terminals send backtab (`ESC[Z`), which ultraviolet maps to
  `KeyTab+ModShift` — the same key the kitty protocol reports — so
  `msg.String() == "shift+tab"` fires everywhere. The bubbles v2
  textarea binds neither tab nor shift+tab and drops them on sight
  (special keys carry no `Text`), so nothing else wants the key in the
  main chat state.
- **bubbletea v2 inline renderer laws (derived from
  `cursed_renderer.insertAbove` + TEA_TRACE, confirmed in tmux):** the
  frame is drawn TOP-anchored at uv's tracked cursor; insertAbove leaves
  that cursor at the new model-frame top; its LFs walk the dead space
  below the frame first and only then scroll (so a seal of K rows scrolls
  exactly `max(0, K − deadSpace)`); a repaint after a frame-height change
  mirrors it — growth scrolls (bottom stays glued), shrink leaves the
  bottom high. Consequence: an insertAbove self-pins a pinned frame iff
  the rendered height didn't change since the last render; otherwise the
  pin drifts by the height delta and needs a follow-up fill AFTER the
  repaint. Also: leading blank/space rows in the View collapse (the diff
  skips them) — never try to pad the View to force position.
- **uv's `insertAbove` runs against the model frame height, not the
  real one** — a seal that coincides with a height change (submit closing
  the completion popup) computes its cursor math from the stale height
  and drifts by the delta. khode's `pinTick` delayed refill exists for
  exactly this; keep any seal-adjacent height change and its follow-up
  fill in separate event-loop turns.

## Session log (append one entry per session)

| Date | Session summary | Commits |
|---|---|---|
| 2026-09-16 | Scaffolded repo; Phase 1 done (TUI + Anthropic streaming + sessions + docs) | baa7520 |
| 2026-09-16 | Phase 2 step 1: OpenAI provider via openai-go v1.12, `--provider` flag, fake-SSE provider test, docs | 7ae2922 |
| 2026-09-16 | Phase 2 step 2: `config.Provider` + per-provider `models` map with legacy migration, flags → overrides, config unit tests, docs | 3de9993 |
| 2026-09-16 | Phase 2 finished: cost estimate (c9cc6ab), named sessions + picker (50bfda7), config/Anthropic tests (af2faf7), docs | af2faf7 |
| 2026-09-16 | Phase 3: llm tool contract + provider translation (ecb9255), tools pkg (57c6c43), agent loop (a997292), UI wiring + tests (c3eac1a), docs | c3eac1a |
| 2026-09-17 | Phase 4: write tools + diff (2c277fa), perm package + loop gate + bridge (557bafe), TUI approval dialog + /mode (f1483c7), docs | f1483c7 |
| 2026-09-17 | Phase 5: project context (f1c8f78), retry/backoff (5d441f3), todo tool (bc422f2), compaction + /compact (98eccb1), docs | 1a50dd3 |
| 2026-09-17 | Phase 6: MCP client (1af8588), subagents (0d21ba2), plan workflow (94d1049), hooks (698ffba), docs | 698ffba |
| 2026-09-17 | Phase 7: auth.json + llm factory + registry mutex (b46b15f), /settings overlay + keyless startup (2351355), docs | b46b15f 2351355 |
| 2026-09-17 | Phase 7 follow-up: first-run walkthrough, highlighted overlay exits, status-line context meter | 3265b34 |
| 2026-09-17 | Phase 7 follow-up: custom providers + model fetching (002796f), docs | 002796f |
| 2026-09-17 | Fixed custom-provider startup crash (name-casing split from map keys), bad-protocol startup fallback, chat input's black cursor-line strip; provider-name collision guard; verified the user's custom provider end-to-end (model list + streaming turn) | 557a92a d4426e0 |
| 2026-09-17 | khateway built-in provider (KhatewayProtocol endpoint-shape resolution, model-picker auto-fetch, no default model, KHATEWAY_* env vars). Verified build/vet/gofmt/tests green on a clean HEAD worktree; the shared working tree had unrelated parallel WIP (reasoning/think-tag support) whose 2 OpenAI tests were red — not ours, left untouched | 662958b |
| 2026-09-17 | Selectable text (mouse capture off by default, alt+m toggle, pgup/pgdn scroll) + thinking split from response (`llm.ThinkingDeltaEvent`, `<think>` splitter, `reasoning_content` raw-JSON read, `thinking` session field, ✻ display block, no provider replay). Note: the main.go mouse-capture hunk rode along in the khateway commit 662958b (shared worktree race) | 2a3a6c6 |
| 2026-09-17 | Walkthrough model step for khateway/customs (auto-fetch + pick on the spot, failure → /settings pointer); `--debug` flag with `internal/debug` gated file logging; README Development section. Watch for the shared-worktree parallel session (khateway WIP in cmd/khode-e2e was mid-write and red during this session — left alone) | 945836c |
| 2026-09-17 | khateway keyless-native (KeyOptional pre-flight exemption, walkthrough key-step skip, `anonymous` placeholder credential, settings "not required" row). Khateway-side follow-up prompt handed to the user: gateway must treat client auth as optional and accept/ignore the `anonymous` bearer + x-api-key values on /v1/chat/completions, /v1/messages, and /v1/models | 0ec4212 |
| 2026-09-17 | khateway select-only (ManagedEndpoint: base-url row read-only with effective-endpoint display, activate/commit guards, provider list unchanged since built-ins were already select-only/undeletable; model + api-key rows intentionally left usable — picking a model and an optional enforcement key are "use", not provider config) | 4f7962a |
| 2026-09-18 | UI polish per user goal (unique/green+cyan/modern/consistent/animation): aurora design system + chat chrome (eddae69), shared overlay dialog language (ecdf9bd), view-dump harness + tidy (1645c5c). Verified via rendered-frame dumps + full green gate (build/vet/gofmt/tests); sandbox pty capture of bubbletea produces no output, so frame dumps are the layout-evidence path | eddae69 ecdf9bd 1645c5c |
| 2026-09-18 | Fixed duplicate top text: the startup banner still carried version/provider/model/session/mode after the aurora header began showing the same things; banner is now hints-only (`/help commands · /settings config`). Gotcha: `TestDumpViews` fails with bare "no truecolor escapes / missing rule" assertions when DUMP_DIR points at a nonexistent dir — `os.WriteFile` errors are ignored, so create the dir first | 3dfba3b |
| 2026-09-18 | Slash-command autocomplete popup: `internal/ui/complete.go` (slashCommands table, cmdPopup filter/keys/view) wired into app.go (key guard above the root switch, syncPopup after textarea updates, submit/esc/tab/enter paths, relayout carve-out); /help now renders from the table; 10 unit tests + popup dump frames + expect-pty e2e (typed /h, enter ran help). Gotcha recorded: expect works once the spawned pty is given a size | c5ebf4e |
| 2026-09-18 | Interactive /tools panel per user ask ("like Claude Code"): registry disabled-set + `Definitions` filter + execCall rejection (loop test), overlay in `internal/ui/tools.go` in the dialog language (risk badges, sliding window, ✓/✗ + strikethrough for off), dump frames for visual check; plus input-key polish (alt+m "wheel scroll" hint, alt+enter constraint comment). Gotchas: tool descriptions can carry newlines → collapse whitespace before `clip` or rows wrap; shift+enter unrepresentable in bubbletea v1 (see Decisions) | 4d87a87 63442c7 |
| 2026-09-18 | User reported alt+m typing µ instead of toggling — default-macOS option composition kills alt+letter bindings. ctrl+o is now the primary mouse-capture key (free in bubbles textarea, no XON/XOFF baggage), alt+m stays as alias; footer, toggle notes, main.go comment, and a key-level test updated. Gotcha recorded: never make alt+letter a primary binding | 44193ac |
| 2026-09-18 | User asked why capture exists at all + noted the terminal scrollbar scrolls past the TUI: alt screen suspends scrollback, so the scrollbar has nothing real to scroll. Dropped mouse capture entirely (believed Claude Code never grabs the mouse): toggle/MouseMsg forward/field/tests gone, selection native from launch, pgup/pgdn scroll. True native-scrollbar history = inline transcript rendering (`tea.Println` into scrollback over an inline program, overlays shrink into the live region) — parked as backlog item 1, needs its own plan | bef8b9b |
| 2026-09-18 | User verified in Apple Terminal that Claude Code and opencode DO consume wheel events (mouse tracking) — the earlier premise was wrong, and web sources confirm recent Claude Code hijacks mouse clicks/wheel with shift as the selection bypass. Re-enabled capture permanently (WithMouseCellMotion + MouseMsg→viewport, wheel test added); shift+drag selects natively, ⌘R toggles Terminal's reporting. Lesson: verify reference-app behavior before citing it as the reason for a removal | ebec1a7 |
| 2026-09-18 | Footer label switched to the standard shift+enter (user request) with both modifier enters bound; the physical key still submits on unmapped terminals — pointed the user at Claude Code's /terminal-setup (writes the Terminal.app/iTerm2 shift+enter→ESC+CR mapping khode then picks up as alt+enter) and floated a khode /terminal-setup equivalent as future work | bc7e4e9 |
| 2026-09-18 | User reported shift+enter not working in iTerm2 — expected: with no key mapping iTerm2 sends plain Return, identical to enter. Fix is terminal-side (Key Mappings → Shift↩ → Send Hex Codes 1b 0d); khode-side ESC+CR→newline wiring pinned by a regression test (TestModifierEnterInsertsNewline) | 36c428a |
| 2026-09-19 | Bubble Tea v2 migration (planned via ExitPlanMode, executed in one atomic code commit + docs): import swaps to charm.land/*, tea.View declaration, KeyPressMsg dispatch, wheel-only mouse case, textarea styles/default-dark + InsertNewline without "enter", "space" matches, PasteMsg → textarea, dump harness drops termenv. Verified all uncertain APIs against module source before coding; smoke test via expect-pty (sized pty → boots, renders, ctrl+c exits; exit sequence shows the kitty `[<1u` pop proving protocol negotiation). Full gate green + dump frames eyeballed | e40738c |
| 2026-09-19 | User hit the first real-world v2 bug: after shift+enter the input showed two empty prompt rows (typed text scrolled out of view). Reproduced with a render-assertion test, root-caused to external SetHeight racing the textarea's internal scroll-follow, fixed with native DynamicHeight + syncInputLayout; pty smoke test typed "hi" + real kitty ESC[13;2u and the frame kept the typed row visible | d6ba85a |
| 2026-09-19 | User verified Claude Code/opencode get shift+enter for free in iTerm2 → root cause: they run Bubble Tea v2, which enables the kitty keyboard protocol (iTerm2 3.5+ reports modified keys); v1 could never. Chose the v2 migration over a hand-rolled shim (research: v2 stable since Feb 2026; opencode on v2; Terminal.app lacks protocol support even for Claude — same caveat stays for khode). Key insight for the terminal-mapping workaround era: ESC+CR still works as alt+enter, so nothing breaks on legacy terminals | e40738c |
| 2026-09-19 | Inline transcript rendering (backlog 1, planned via ExitPlanMode, v2 insertAbove facts verified from module source before coding): viewport/wheel/pgup deleted, watermark `printed` + `flush()` print model, banner-in-scrollback (user choice via question), live-budget height−2, overlays as bounded centered boxes (`listWindow`), status line absorbs mode+model, `useSession` transcript replay. One real bug caught by tests mid-rework: `ensureStreamingBlock`'s kind-switch returned before appending the new streaming block (answer text vanished). Verified: full gate green, dump frames (scrollback chunk + live region), expect-pty smoke showing `[6L`/`[L` scrollback inserts above the frame, zero `[?1049h` | d52f53d |
| 2026-09-19 | Mode switching UI (planned via ExitPlanMode; user picked interactive picker + above-input indicator): `perm.Next` ladder + quiet `cycleMode` on shift+tab (guarded behind all overlays, works mid-stream), `modeHint` line above the input (per-mode accent, hidden at ask, width-clipped so it can never wrap out of the 1-row budget), `modepicker.go` replacing bare `/mode`'s printed list, helpLine + `/mode` desc updated. Tests: cycling walk + persistence + zero notices, overlay precedence, picker select/dismiss/wrap, hint presence + liveChrome accounting; dump frames `mode-picker.txt`/`mode-hint.txt` eyeballed. Hit the already-recorded value-receiver trap again (un-captured resize left `m.width` 0 and the picker box crushed) | a537a0f |
| 2026-09-19 | User reported the inline UI "not full screen" and asked for Claude Code's look; delivered the bottom-pinned frame after a long renderer forensics session: TEA_TRACE + insertAbove source → the two-regime pin law; blank-fill spikes (pyte + hand-built expect) → pyte unreliable on kitty sequences, screen(1) hardcopy dead, brew tmux = ground truth; fill rides the seal chunk (atomic), refill delayed one tick for the height-mismatch drift; wrapper mirrors growth/shrink re-anchoring. Unit tests (pin_test.go) + tmux verification of boot/esc/seal/picker/shift+tab/multiline all ending with the help line on the last row. Removed: nothing user-visible; the fill blanks are invisible in scrollback | (this commit) |
| 2026-09-19 | User's first pinned-run feedback: the wheel scrolled the scrollback (should not) and the header wrapped (two-row rule, mode chip pushed off). Fixed: MouseModeCellMotion on the View + an explicit MouseWheelMsg swallow, and header() built to width−1 for flush's space prefix (test: TestHeaderFitsPrintWidth). Wheel is deliberately INERT — history reachable via scrollbar/terminal search; in-app transcript scrolling on wheel-up is a possible follow-up feature if wanted | (this commit) |
| 2026-09-19 | User reported the command popup staying in the chat history: root cause is uv never erasing rows the frame vacates; fixed with the shrink-absorbing pad (chat-only, cap 12, consumed by the next transient, refill fallback beyond cap). Verified in tmux: popup esc, picker apply, and seals all leave the pin intact with no box remnants; a stray row can survive in long mixed sequences (documented limitation). A pad-drain-on-seal variant was tried and reverted — it left the pin one row short | (this commit) |
