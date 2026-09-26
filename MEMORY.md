# MEMORY.md — Cross-Session Memory & Interrupt Recovery

Purpose: let any agent (or the human) resume work after a gap or an
interrupted session **without re-discovering the project**.

## Recovery procedure (read this first)

If you are starting a session, or recovering after an interrupt:

1. Read `STATUS.md` — current state, changelog — and `ROADMAP.md` —
   phase checklist, backlog.
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
- **Device sign-in + guest-pool billing (2026-09-24):** khode ships a
  khateway device-flow login: `/login` (internal/khateway Start/Poll with
  ErrPending/ErrDenied/ErrExpired sentinels; ui/devicelogin.go dialog)
  mints a request, shows the verification URL + XXXX-XXXX code (auto-opens
  the browser, `o` reopens), polls at the minted interval, and on approval
  banks the returned personal API key via `auth.SetKey(khateway, …)` +
  `auth.Save()`, switches provider (switchProvider → rebuildProvider picks
  up the new key), and auto-picks the first listed model (fetch →
  cacheModelChoices → SetModel). The dialog is opened by `/login`, the
  walkthrough's khateway step, and the settings key choice, and is
  dispatched/rendered above all of them. SUPERSEDED same day: the
  **guest pool** (keyless /v1 traffic billing a funded portal account,
  `keyless_guest_email`) — the gateway dropped keyless entirely, so khode
  dropped every keyless path; the sign-in flow itself is current.
- **SUPERSEDED (2026-09-24, keyless removed):** the entry below — the
  keyless-gate access secret — is history only: the gateway removed the
  keyless gate, and khode removed the secret, the header, and keyless
  requests (see "Keyless removed — sign-in or a real key" in STATUS.md
  Now).
- **Keyless-gate access secret (2026-09-24):** official khode builds
  embed `llm.khatewayAccessSecret` at compile time —
  `KHODE_ACCESS_SECRET=<secret> scripts/build-release.sh` runs
  `go build -ldflags "-X khode/internal/llm.khatewayAccessSecret=…"`
  (the var is a package-level `var`, empty in the repo, never
  committed; `dist/` is gitignored). Every khateway request — openai
  face, anthropic face, `FetchModels` — carries it as
  `x-khateway-access` (`factory.go` builds an `extraHeaders` map the
  client constructors apply via `option.WithHeader`). Repo builds send
  no header; a khateway with the keyless gate on answers 401 and the
  user sets `KHATEWAY_API_KEY`. The gateway side stores only the
  secret's sha-256 (`settings` row `keyless_gate_secret_hash`,
  admin Settings card, `PATCH /api/admin/settings
  {keyless_gate_secret}`). Wire tests: `khateway_test.go`
  (`TestKhatewayAccessSecretHeader`).
- **Not yet started:** backlog only — see ROADMAP.md "Next".

## Decision log

| Date | Decision | Why |
|---|---|---|
| 2026-09-26 | The stream cursor is appended after an ANSI-aware trim of the last row's padded tail (`trailingPadRe`), not after the block-width padding; the header rule's shimmer is per-cell `shimmerColor` on the breath clock, not a second ticker | lipgloss pads every bar row to the block width, so a cursor appended behind the padding lands one cell past the viewport's content width and wraps onto a bare bright `▌` row at column 0 (the "thin line over thick line" report — same stray-bar family as 2026-09-25, different trigger); the shimmer rides the existing spinner-tick re-render like every other breathing element |
| 2026-09-26 | Icons live in one table (`internal/ui/icons.go`) with three packs behind `config.Icons` (auto=Unicode, nerd=Nerd Font opt-in, ascii=plain punctuation); emoji deliberately excluded; the `⎿` result connector stays a literal in every pack | nerd codepoints cannot be auto-detected (needs a patched font, so it is an opt-in) and emoji render double-width + clash with the aurora palette; a table lets the nerd pack differentiate per tool; the connector is grammar, not identity |
| 2026-09-26 | The breathing animation is `breathColor(elapsed)` — a sine over `turnStart` rendered per frame — not a new ticker; thinking/assistant attribution is an icon+label header line above the block, not a prefix inside the markdown | the spinner tick already re-renders the live region ~10×/s so wall-clock phase costs nothing (same law as the elapsed timer, 2026-09-18); a header survives glamour, while a prefix inside `raw` would be re-flowed and duplicated across markdown constructs |
| 2026-09-25 | `subagent_model` is a single global override (not per-provider) read live through `SubagentConfig.SubModel`; "" falls back to the main model at spawn time | subagent runs are short and kind-scoped, so one cheap-model knob covers the explore/gatherer use case; the live func follows the existing Model/Mode closure precedent so /settings applies to later spawns without re-registration |
| 2026-09-25 | The first-prompt gatherer is UI-driven (submit → startGather → read-only runner on the SAME stream channel, routed by a `gathering` flag; gather block converts to the kindContext block on finish), triggered only when the transcript is empty, and never blocks the turn on failure; esc during the gather cancels the whole submit | the brief must exist before the main runner is built (it becomes `Runner.Preface`), the read-only registry needs no approver so the Bridge is untouched, and an empty transcript is the only reliable "fresh session" signal; a failed gather that blocked the answer would be worse than no brief |
| 2026-09-25 | A gatherer brief rides `Runner.Preface` into the transcript as its own user message wrapped in `<task-context>` tags (prefix-detected at replay, rendered dim/collapsible) — not a field on the session line and not a wrap of the user's message | session stays the single truth with zero schema changes; the provider needs no new concept (it is just a user turn); compaction summarizes it like any message; prefix detection avoids touching `line`/`llm.Message` for a display-only distinction |
| 2026-09-25 | Subagent activity rides a `SubagentConfig.Progress` callback (non-blocking send to a buffered UI channel, drop on full) and the UI tracks the ONE active task by message index + call id — no agent-side task-id plumbing | tool execution is sequential so at most one task is in flight; progress is best-effort display state that must never stall the child; a nil channel in `waitForEvents`' select never fires, so tests opt out by passing nil |
| 2026-09-25 | Subagent kinds live in `internal/agent/subagent.go` (`normalizeKind`/`registryFor`); unknown `subagent_type` values fall back to general-purpose instead of erroring; explore/gatherer/plan are read-only (read/glob/grep only) with per-kind report caps (16K general, 8K explore/gather, 12K plan) | the parent picks a profile instead of describing one per call; read-only registries make those kinds approval-free (RiskRead all the way) and plan-mode-safe with zero Bridge involvement; fallback-over-error keeps older callers replayable |
| 2026-09-25 | Diff bands are raw SGR background injection after chroma's colors (`bandLine` strips chroma's per-line reset, adds `\x1b[48;2;…` + width pad), not lipgloss Background and not a chroma style-level background | lipgloss backgrounds die at chroma's embedded resets, and chroma's truecolor formatter calls `clearBackground(style)` — style-level backgrounds never reach the wire; only the manual SGR survives. Bands sit on lines whose numbering comes from parsing `@@` headers (old numbers on `-`, new on `+`) |
| 2026-09-25 | Diff code highlighting picks the chroma lexer by file extension only — no `lexers.Analyse` content sniffing | Analyse highlighted a `.blob` containing `const x = 1;` as JavaScript; the diff always knows the real path, so sniffing only adds surprise |
| 2026-09-25 | Expansion is a toggle on the most recent truncated block (ctrl+o, or a click on the block's registered region), not a scrollable sub-view | matches the chat pane's flat transcript model (viewport window already handles tall content); Claude Code's ctrl+o precedent |
| 2026-09-25 | Tool call lines summarize arguments by tool shape (bash → command flattened to one line, read/write/edit → path, glob/grep → pattern, plan → nothing, task → description), falling back to compacted JSON only for shapeless tools | the model's raw JSON (`{"command":"mkdir -p …"}`) is noise in the transcript; the user asked for readable rendering and every common tool has one argument worth showing |
| 2026-09-25 | Answer-bar prose drops trailing bar-only rows and whitespace-only streaming blocks are dropped at seal/switch; delta updates target the open streaming block by scan, not `len-1` | mid-stream raw regularly pauses inside an unfinished markdown construct (unclosed fence, started list/heading) that glamour renders as an empty final row — it painted as a stray second vertical bar during every thinking pause; `len-1` targeting froze the block when activity (todo panel, compaction) appended after it |
| 2026-09-25 | Edit/write chat diffs are computed from the tool input alone (`tools.ChangeDiff`: edit = `old_string`→`new_string`, write = all-additions), never by touching the file | race-free live (exec may already have run when the UI handles the call event) and identical on `--resume` replay, where the file has changed and pre-write content is unrecoverable |
| 2026-09-25 | Todo updates render as one upserted checklist panel at the live edge (todo call lines suppressed), not one result block per update; the panel reads the tool's `List()` for original order, and replay pairs results to todo calls by call id | Claude Code parity the user picked over a pinned panel; the tool's own render reorders by status (lines would jump between updates) and transcript results can interleave with other tools' in one round |
| 2026-09-25 | The model is driven to the todo list by prompt text (base system prompt) + the plan tool's approval result, not by auto-seeding todos from the plan | the model composes better item wording than a mechanical plan→items split; the approval result is the strongest lever — it is the exact tool output the model reads at the switch to implementation |
| 2026-09-24 | User messages render as a green left rule (`userBar`); `userCard`'s background slab deleted | filled backgrounds are where terminal color degradation bites — the user saw black-on-green; bars match the answer-bar grammar so all transcript roles read as one family |
| 2026-09-24 | Input ↑/↓ history gated to the cursor being on the first/last (visual) line, draft stashed | multi-line drafts keep line-navigation semantics; shell convention; seeded from the transcript so `--resume` recalls what that session sent |
| 2026-09-24 | Click-to-cursor ports bubbles' textarea `wrap()` column-for-column into `internal/ui/input.go` | the v2 textarea has no mouse support; clicks can only land where text renders, so the mirror must track `wrap()` across bubbles upgrades |
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
| 2026-09-24 | khateway requires a credential: `config.KeyOptional` deleted, the `anonymous` key + `khatewayAccessSecret`/`x-khateway-access` header removed; one construction-only `khatewayUnauthenticatedPlaceholder` keeps the SDK clients buildable, the pre-flight (which now points at `/login` for khateway) makes it unreachable on the wire, `KHATEWAY_API_KEY` via orEnv still wins, and the walkthrough's khateway path + the settings api-key row offer browser sign-in vs paste | the deployed gateway now REJECTS every /v1 request without a valid client key (401 invalid_api_key) and removed its keyless gate, so keyless was dead weight that could only produce 401s; sign-in or a pasted key are the only ways in |
| 2026-09-24 | The device dialog (`deviceLogin`) is answered and rendered ABOVE welcome and settings in the dispatch chains | it can now be opened from the walkthrough's khateway step and the settings key choice; welcome would otherwise eat esc and close the whole walkthrough mid-sign-in (esc must return to the choice, and approval advances the walkthrough to its model step) |
| 2026-09-24 | `DefaultKhatewayEndpoint` (and its standalone mirror `internal/khateway.DefaultBaseURL`) is the deployed gateway `https://khateway.chengsokdara.workers.dev/v1`, not localhost:8787 | khateway is first-class native for khode — the binary must work on a fresh install with zero configuration (pick provider → /login → go); URL confirmed from khateway's wrangler.jsonc (worker `khateway`, no custom domain) + live probe (/health 200, keyless /v1/models 401); local dev overrides via `KHATEWAY_BASE_URL`, and a test pins the https default |
| 2026-09-24 | The walkthrough leads with khateway and its cursor starts there; `/welcome` re-runs the walkthrough on demand | first-class-native providers are the recommended path, not a third option; esc-skip was never sticky (main.go reopens the walkthrough while no key/custom/model evidence exists) but a user who persisted something partway (banked key, cached model list) had no way back in — `/welcome` rides the shared slashCommands table so completion and /help document it for free |
| 2026-09-24 | A skipped walkthrough is not silent: `setupHint` renders a persistent banner in the chat frame whenever the pre-flight would block a turn (no key → /welcome + /login-or-/settings; key but no model → /settings → model), cleared the moment setup resolves | user agreed the esc landing spot was confusing — "cannot do anything" with no visible explanation; the banner keeps setup-never-a-wall while making the blocked state (and its way out) visible at all times; clipped to one physical row like modeHint so it can never break the frame height |
| 2026-09-17 | SUPERSEDED 2026-09-24 (keyless removed) — khateway is keyless-native: `config.KeyOptional` exempts it from the pre-flight key check (submit + /compact) and the walkthrough skips its key step; with no key configured, requests carry the `anonymous` placeholder credential set at client construction | the user wants choose-and-go with zero setup, and the gateway fronts upstream auth itself; `KHATEWAY_API_KEY` / a stored key stay as overrides for gateways that enforce client keys — the gateway side is expected to treat auth as optional |
| 2026-09-17 | The keyless placeholder lives in `llm.NewProtocol`'s khateway branch, not the UI | both SDKs need a non-empty credential: anthropic-sdk-go refuses to build ANY request client-side (`NoCredentialsError`) without one — even against a keyless custom base URL — and openai-go silently sends `OPENAI_API_KEY` as the bearer, leaking an unrelated key to the gateway (this SDK constraint is exactly why today's construction-only placeholder still exists) |
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
| 2026-09-21 | Full-screen rendering (View.AltScreen) is the final answer to the rendering saga; inline+scrollback is reverted. The deciding evidence: a field screenshot showed whole frame fragments (popup boxes, banners, inputs) stacked into scrollback — every seal can scroll the frame's own pixels into history, and no bookkeeping can prevent that class of bug because uv's anchor is unknowable client-side. All five user complaints (ghosts, lingering gap, crawl, idle gap, duplication) are unsolvable in the inline renderer individually patched, and all trivially satisfied by the alt screen where every frame repaints the whole terminal | the viewport is an exactly-`rows`-tall window (slide, not grow — a growing window gets its top rows clipped by the height clamp, which made scrolling a visual no-op until fixed), scrolled by pgup/pgdn; the frame is bottom-pinned (spare rows pad ABOVE); the mouse is NOT captured so drag selects visible alt-buffer text natively — the "selection is gone" complaint is what un-did the capture, and the wheel comes with it (no scrollback behind the alt buffer for it to move); snap-to-live on submit/stream events |
| 2026-09-22 | Bare `/model` opens a centered picker dialog (`internal/ui/modelpick.go`, the /sessions dialog shape: cached choices, cursor pre-set on the active model, type-to-filter, `f` fetch + auto-fetch-on-empty, enter = `SetModel`+save+notice) instead of printing a usage line; `/model <name>` unchanged; the completion row's args went empty so popup-enter runs bare `/model` at once | "switch models easily" deserves a real surface, and the plumbing already existed — per-turn Runners read `cfg.Model()` (no live swap needed) and `fetchModelsCmd`/`applyFetchedModels` are shared with settings/walkthrough; empty `args` is the command table's only lever for immediate-run, so the direct-set form moved into the row's description |
| 2026-09-22 | The model dialog has no j/k navigation — printable keys feed the filter (arrows + ctrl+p/n move the cursor), and `f` belongs to fetch, not the filter | a filter that swallows j/k can't spell model names containing them; the filter path is textinput's own printable check (`msg.Text != ""`), so j/k must be filter characters; `f`-fetch keeps settings-picker muscle memory, at the accepted cost of never filtering for a literal "f" |
| 2026-09-23 | `Runner.Mode` is a `func() perm.Mode` re-read in `execCall` (nil → DefaultMode); the task tool passes its live mode func straight through to subagents | a per-turn snapshot made mid-turn mode changes inert; the func is the existing `PlanTool`/`SubagentConfig` live-closure precedent over `cfg.PermissionMode` — no new sync machinery, and one `Mode` field now serves turn, compaction, plan tool, and subagents alike |
| 2026-09-23 | The approval dialog cycles modes on shift+tab (`permKey` → `cycleMode` + `autoResolvePerm`) and self-answers true only when `perm.Decide(newMode, req.Risk) == DecisionAllow` on a `KindTool` request | the user's ask: switching to accept-edits while asked must stop the asking — auto-resolve only in the allow direction (user choice: a stricter switch leaves the dialog for a manual answer, never an auto-deny); the `KindTool` guard keeps plan approvals manual and keeps the plan-approval `setMode` path from re-entering `answerPerm` |
| 2026-09-23 | Assistant prose rides a left answer bar (bright cyan on the turn's final answer, dim teal mid-turn); markdown applies at seal, never per-delta; "final" = the turn's closing text block, marked live in `finishStream` and on replay by `isFinalAnswer` (assistant prose, no pending tool calls, followed by the next user message) | user picked the bar over a diamond marker or a box (works at any message length); per-delta glamour is O(n²) and jank-prone on long replies while at-seal is one visual moment per block; the replay rule mirrors the live marking so `--resume` renders identically, and errors keep the dim bar because the failure note is the loud end |
| 2026-09-23 | Superseding the markdown-at-seal half of the row above: streaming text renders markdown live too (same pipeline, cursor still trails), and both approval dialogs became scrollable readers (window + gutter scrollbar, ↑↓/jk/pgup/pgdn/home/end) with the plan rendered through the aurora theme | user asked for readable plans and markdown everywhere; per-frame glamour on one growing block measured fine (a few ms), and the at-seal rule had a real cost — `block()` cached the streaming render, so mid-turn seals replayed a cursor-trailed raw body; scrolling follows the repo's hand-rolled line-window idiom (`listWindow`, `messageViewport`), not a new viewport dependency |
| 2026-09-23 | The mouse is captured for the wheel again (`MouseModeCellMotion` on the View, reversing 2026-09-21's "capture nothing"): wheel ticks scroll the open approval dialog's body or the chat viewport, 3 lines per tick (`wheelStep`; directions are opposites — `permScroll` counts from the top, `m.scroll` back from the live edge) | the alt-screen rationale — "the wheel belongs to nothing, the alt buffer has no scrollback" — is false in iTerm2, which scrolls its own scrollback under alt-screen apps that don't report the mouse: the user wheeled clean out of the TUI and the new dialog scrollbar was unreachable by wheel; Claude Code captures the mouse the same way, and selection survives via the terminal override (shift-drag, option-drag in iTerm2) |
| 2026-09-23 | User messages render as full-width dark-green slab cards (`userCard`, `hexUserBg #123524`) instead of a bare `❯` prefix; the assistant keeps its cyan answer bars | user asked for stronger user-vs-agent distinction; of slab / green-bar / rounded-card mockups the user picked the slab — container-vs-prose reads fastest when scanning, costs no extra rows (a box costs two), and green = you / cyan = khode stays inside the aurora palette's fixed semantics; user text stays raw markdown-free (input is literal) |

| 2026-09-23 | Dialog scrollbar: one glyph family (`██` thumb / `░░` track, 2 cells), exact clamp in `scrollPerm` against the shared rendered body (`permBodyLines`), and mouse interaction (thumb grab+drag, track click pages) driven by render-recorded screen geometry in package vars | the user hit all three gaps in real use: `▐`-vs-`│` rendered misaligned/disconnected in iTerm2 (glyph metrics differ per font — full blocks stack seamlessly), the coarse offset bound froze the view at the bottom until extra pgups unwound (clamp where state changes, not just where it is displayed), and a 1-column unclickable gutter wasn't a scrollbar; geometry lives in package vars set per render like `dlgLines` — safe in the single-goroutine UI and always from the latest frame |

| 2026-09-23 | User slab v2 after the live-terminal screenshot (dark text on the band, full-width paint for a short message): `userCard` carries an explicit light foreground (`colText` — a filled band with terminal-default text is unreadable), and the slab hugs the widest wrapped line instead of the terminal width (`reflow/wordwrap` at width−4, two-space hanging indent under the ❯, long words clipped); reflow promoted to a direct dep | no explicit foreground means the terminal's default, which varies by profile and died on green; edge-to-edge bands read as wallpaper — a card should be as wide as its content, not as the screen |

| 2026-09-23 | Scrollbar cutoff fix (user screenshot: bar cut into segments where plan text overflowed): glamour applies list indent AFTER wrapping and chroma never word-wraps code, so some lines exceeded the body width and the body pad's `Width()` wrapped them onto gutter-less physical rows — desyncing geometry and punching gaps. Fix is three layers: wrap markdown at bodyWidth−6 (`planWrapSlack`), ANSI-aware re-wrap of any still-wide line (`wrapOverflow`), `MaxWidth` on the pad as the hard guard | a padded/wrapped style must never be the thing guaranteeing one-row-per-logical-line when a scrollbar's geometry depends on it; give the formatter slack for post-wrap indents, re-wrap the stragglers, and truncate as the last resort |

| 2026-09-24 | Click targets = render-time region registry (`ui/click.go`), not per-handler geometry recomputation | WYSIWYG — regions always describe the frame on screen (the scrollbar's `sb*` precedent generalized); one surface renders per frame, so no precedence checks beyond the kind |
| 2026-09-24 | List rows select-then-activate (first click moves ❯, clicking the selected row = enter; double-click opens) | user choice — safe against accidental activation, standard TUI convention; checkboxes (/tools) and transient menus stay single-click |
| 2026-09-24 | Footer chips + row activation synthesize `tea.KeyPressMsg`s routed through the factored-out `handleKey` | a button and its key can never drift apart — zero duplicated action logic across nine overlays |
| 2026-09-24 | Turn hang bounds: SDK retries off (`WithMaxRetries(0)`), 45s wall-clock retry budget, 90s stream stall guard, `insufficient_quota` never retried | three retry layers stacked on khateway's 60s upstream timeouts pinned turns in "working" for ~10 minutes, and a mid-stream stall had no bound at all; errors must surface fast with their cause intact |
| 2026-09-24 | Retries announced via `llm.RetryEvent` → status-line note, not chat blocks | the spinner alone made budget waits indistinguishable from a hang; status keeps the transcript clean (notices are display-only) |

## Gotchas & lessons learned

- **Self-testing TUI features in a live TTY (the user asked for this
  instead of screenshots)**: `scripts/tmux-selftest.sh` runs khode
  against `scripts/fakeai.py` (scripted OpenAI SSE: thinking + prose +
  write + edit rounds) inside tmux on the ISOLATED socket `-L khv` —
  never the user's tmux server. `capture-pane -p` gives the readable
  frame, `-e` adds SGRs; the user's features (ctrl+o expand) drive fine
  via `send-keys C-o`. Gotchas: tmux re-encodes truecolor to the 256
  palette in -e captures (48;5 forms — the band's tint shifts; trust
  the raw SGR unit tests for exact hexes); the fake server's round
  counter is process state, so restart it per scenario; a full-screen
  app exiting takes the socket's whole server down if it is the only
  session (known gotcha below). Verified end to end: write diff
  collapsed/expanded, edit with both bands, collapse cycle.

- **OpenAI-protocol streams that carry both `reasoning_content` and
  inline `<think>` are not duplicating**: `TestOpenAIThinkingStream`
  pins that a stream sending "ponder " via `reasoning_content` and
  "<think>more thought</think>Answer text" via content concatenates
  BOTH into thinking ("ponder more thought") and answers "Answer text"
  — some providers emit complementary reasoning through the two
  channels. Suppressing the `<think>` splitter once `reasoning_content`
  speaks (tried 2026-09-25 for the "duplicate thinking" report) leaks
  raw tags into the answer; the real duplication was the UI rendering
  streaming blocks twice.
- **bubbles v2 textarea facts that bit the click-mapping work**: it has
  ZERO mouse support (`Update` handles only `PasteMsg`/`KeyPressMsg` —
  cursor placement must be done app-side); the Prompt renders on EVERY
  visual row, not just the first; `wrap()` output appends exactly one
  phantom trailing space per logical line (only on its last segment) —
  mapping code must clamp against it; `m.col` is a logical rune index,
  so `MoveToEnd`+`CursorUp`+`SetCursorColumn` is the cursor-positioning
  toolkit; the viewport's content/height are only refreshed inside
  `Update()`, so a test that drives `SetValue`+`MoveToEnd` directly
  never scrolls (`ScrollYOffset` stays 0) — pump a no-op `KeyPressMsg`
  (e.g. F1) first; and `CursorUp/Down` move VISUAL rows (soft-wrap),
  not logical lines — walk with `for ta.Line() > i { ta.CursorUp() }`.
- **khateway 504 + khode retry stack-up (FIXED 2026-09-24)**: a stalled
  upstream reaches the client as the gateway's own `upstream_timeout` 504
  after khateway's 60s cap; it used to stack into minutes of silent
  "working" because ALL THREE retry layers fired at once — the SDKs'
  built-in retry (default MaxRetries 2, retries any 5xx), khode's 4-retry
  ladder treating 504 as transient, and (for mid-stream stalls) nothing
  at all, so Next() blocked forever. Now `WithMaxRetries(0)` disables the
  SDK layer, a 45s wall-clock retry budget (`DefaultRetryBudget`) stops
  the ladder the moment attempts are expensive (a 60s 504 exhausts it on
  the first try — fast transient failures still retry all 4), a 90s stall
  guard (`streamStallLimit` in retry.go) cancels any stream that stops
  producing SSE events, and `insufficient_quota` 429s never retry. Retry
  attempts surface as `RetryEvent` → status line "retry 2/5 · 504 …".
  Worst case per LLM call is now ~90s + backoff, never infinite. When
  khode turns still fail against khateway, check the gateway's registered
  models against a live upstream first, not khode. Refinements from the
  2026-09-23 diagnosis: kiosapi.com's free routes flap on a minutes scale
  (deepseek-v4.1-flash-free went all-hang → all-2s within half an hour),
  so re-probe before concluding anything is broken; the user's "working
  curl" bypassed khateway (direct to kiosapi.com with their own key), and
  khateway's per-provider `timeout_ms`
  (default 60s, cap 120s, providers table / dashboard) is the knob for slow
  routes.

- **anthropic-sdk-go ≥ v1.73**: no `anthropic.F()` wrappers, no
  `NewUserTextMessage`. Use `MessageNewParams{...}` plain fields,
  `anthropic.NewUserMessage(anthropic.NewTextBlock(s))`, and
  `stream.Current().AsAny()` type switches (`ContentBlockDeltaEvent` →
  `ev.Delta.AsAny().(anthropic.TextDelta)`).
- **glamour v1.0.0**: `glamour.NewRenderer` was removed → use
  `glamour.NewTermRenderer(...)` with the same option names.
- **glamour `WithAutoStyle()` silently renders colorless**: with no TTY
  background detection (tests, some terminals, pipes) auto falls back to
  the NoTTY style, so markdown output carries zero ANSI — this was the
  root cause of khode's "final answer looks like gray wallpaper". An
  explicit `glamour.WithStyles(cfg)` theme always emits truecolor spans,
  which also means **content assertions on glamour output must go
  through `ansiStrip`** — word-level spans break raw `strings.Contains`
  (wordwrap wraps every word in its own escape run), and glamour pads
  lines out to the wrap width, so normalize trailing spaces before
  asserting on line structure. glamour's style configs live in the
  `styles` sub-package in v1 (`styles.DarkStyleConfig`); its `Chroma`
  struct can be dereference-copied to fork syntax highlighting (all
  fields are value `StylePrimitive`s).
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
  option+return has no composed character. (The alt+m wheel toggle this
  rule came from is long gone; mouse capture for the wheel returned
  2026-09-23 — see Decisions.)
- **alt screen + no mouse reporting ≠ inert wheel**: iTerm2 scrolls its
  own scrollback under alt-screen apps that don't turn mouse reporting
  on, so the user can wheel clean out of the TUI (and terminal settings
  differ — some terminals send arrow keys instead). Any full-screen TUI
  that wants the wheel must declare `MouseMode` on its `tea.View` and
  handle `tea.MouseWheelMsg` itself; selection survives via the
  terminal's override (shift-drag, option-drag in iTerm2).
- expect(1) CAN drive the real TUI after all: the "zero child output"
  noted on 2026-09-18 was bubbletea never receiving its
  `WindowSizeMsg` — expect's pty has no size, so the app paints
  "starting…" forever. Fix: `stty rows 30 columns 100 <
  $spawn_out(slave,name)` right after `spawn` (any resize → SIGWINCH
  also works). Anchor sends on frame text ("welcome to khode" → esc →
  "ready") rather than sleeps; verifed end-to-end for the slash popup.
- glamour renders markdown on the sealed message; streaming text used to
  show wrapped plain text (perf). Reversed 2026-09-23 — streaming rides
  the same pipeline live, and streaming renders must NOT populate the
  block cache (`block()` guards the write-back), or a mid-turn seal
  replays the cursor-trailed streaming body instead of the sealed view.
- glamour composes styles as **current-block ⊕ child** where a non-nil
  child field always wins — including `Text` over the heading it sits
  in (plain text nodes render as `bs.With(Styles.Text)`). A themed
  `Text` color therefore silences H1–H6 and blockquote tints; leave
  `Text` colorless and let body text inherit from Document/paragraph.
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
- **`tea.KeyMsg` is an interface; `Text` lives on `tea.KeyPressMsg`** —
  printable-input detection (list filters, free-typing states) must take
  the concrete `tea.KeyPressMsg` and check `msg.Text != ""`: empty for
  every special key and modifier combo, populated for printable runes
  even on legacy terminals (the decoder synthesizes it). `msg.String()`
  is the wrong tool — space renders as `"space"` and multi-rune
  graphemes break string matching. This is exactly what bubbles v2
  textinput's default case does.
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

- **chatView's chrome budget must count rows, not bands**: the transient
  band between viewport and input is multi-row (the completion popup is
  `popupHeight()` rows), but the old budget counted `len(mid)` entries —
  with the popup open the frame overflowed and the renderer trimmed the
  top, clipping the header. Always sum `lipgloss.Height` per band (and
  compute band positions bottom-anchored so the top-trim path can't
  invalidate them).
- **bubbletea v2 synthesized keys**: `KeyPressMsg` is `Key` — construct
  `{Code: 'y', Text: "y"}` for runes, `{Code: KeyTab, Mod: ModShift}`
  for shift+tab; `String()` then matches the real key names the handlers
  switch on ("enter", "esc", "space", "shift+tab"…). Pinned by
  `TestKeyPressStrings` — a drift here silently unhooks every chip.
- **`go test` can write the developer's real `~/.khode/`**: `config.Dir()`
  resolves `$HOME` at call time, so ANY test that reaches a persisting
  path (`setMode`/`cycleMode`, `/model`, walkthrough or settings commits,
  `cfg.Save()`) without `t.Setenv("HOME", t.TempDir())` overwrites the
  live config — this shipped a real clobber (2026-09-25): `ui`'s
  `newTestModel` fixture (provider "test", "test-model", mode from the
  test) replaced a working khateway config while every test stayed green
  (persist-then-`config.Load` tests read back their own write). Rule:
  every test Model goes through a constructor that isolates HOME —
  `isolateHome(t)` in `internal/ui` — and config/auth-touching tests in
  any package do the same. Never assert persistence by reloading the
  real path without isolation.

## Session log (append one entry per session)

| Date | Session summary | Commits |
|---|---|---|
| 2026-09-25 | Subagent features wrap-up: AGENTS.md architecture section documents subagent.go kinds, task.go's new schema/progress, Runner.Preface, the UI gatherer, and the `gather_context`/`subagent_model` knobs | (this commit) |
| 2026-09-25 | Subagent features, commit 5 of 5: `subagent_model` config (trimmed accessor `SubModel()`, live-read `SubagentConfig.SubModel` func) routes task subagents and the gatherer onto a cheaper model; `/settings` "subagent model" editor row (empty = main model, same fallback). Tests: subagent request carries the override while the parent keeps its model; config round trip incl. the omitempty-clears trap (Unmarshal into a reused raw keeps stale values) | (this commit) |
| 2026-09-25 | Subagent features, commit 4 of 5: the automatic new-session context gatherer — submit runs a read-only sweep (gatherer registry, MaxRounds 15) before the first turn of an empty session; live `◆ gathering context` block + status line; on completion the block converts to the durable `◆ context brief` block and the turn starts with the brief as Preface; failure → note + plain turn, esc → full stop; `gather_context` config (default on) + /settings toggle row. tmux-verified: mid-gather block/status, brief block, transcript injection, second prompt skips, task scenario intact (fakeai routed by body markers, holds widened for readable captures). 6 new tests (gather→turn handoff, disabled, esc, fresh-only, config round-trip) | (this commit) |
| 2026-09-25 | Subagent features, commit 3 of 5: `Runner.Preface` appends a `<task-context>`-wrapped user message ahead of the turn's user message; replay renders it as a dim collapsible `◆ context brief` block (new kindContext, expandable via ctrl+o past 4 lines). 4 new tests (preface ordering, no-preface unchanged, replay collapsed+expanded, short brief without hint) | (this commit) |
| 2026-09-25 | Subagent features, commit 2 of 5: subagent activity streams into the TUI (roadmap Next #1 done) — `SubagentConfig.Progress` forwards child tool calls (kind label, flattened activity, count) over a buffered channel into the waitForEvents select; the active task call block upserts a dim nested line and clears it at the result. 5 new tests (agent progress forwarding + UI render/clear/stale). Verified live: fakeai extended with an explore-subagent scenario (grep round, held report round so the line is readable), tmux captures show `⎿ explore · grep package · 1 calls` mid-flight and the report block replacing it | (this commit) |
| 2026-09-25 | Subagent features, commit 1 of 5 (user: "implement subagent features… a special context gatherer on a new session… think of other use cases like mainstream TUIs"). Planned via plan mode (user picked: automatic gatherer trigger, +plan kind, subagent_model). Typed subagents: `subagent.go` kind catalog (general-purpose/explore/context-gatherer/plan), task schema gains `subagent_type`+`description`, per-kind read-only registries + system sections + report caps; 6 new agent tests. Next commits: TUI activity streaming (roadmap #1), Runner.Preface, auto-gather, subagent_model | (this commit) |
| 2026-09-25 | Documented the self-verification loop as `WORKFLOW.md` (user request after the harness proved itself): the loop, tmux harness usage + cleanup commands, fake-model scenario extension, the two-layer rendering-test rule (text via ansiStrip, exact SGRs + occurrence counts — presence-only checks let the broken band ship), raw-SGR-stream debugging recipe, known test traps, and the gotchas list consolidated from this week's sessions | (this commit) |
| 2026-09-25 | User: "can't you run khode in your own tty" — yes; built the self-test harness (scripts/tmux-selftest.sh + scripts/fakeai.py, isolated tmux socket + scripted OpenAI SSE server) and verified the diff features live: boot clean on a preconfigured HOME, thinking + prose + write turn, 27-line diff capped with ctrl+o expand/collapse cycle, edit turn showing both bands and old/new gutter numbers, -e capture proving band coverage per row. One fake-server bug found on the way (fragment joining must produce valid JSON — khode correctly rejects malformed args). Harness committed for every future TUI feature | (this commit) |
| 2026-09-25 | User: "that's worst" — screenshot showed first-token-on-black rows (band killed by the gutter's SHORT reset `\x1b[m`; the re-injection only knew `\x1b[0m`) and a wall of saturated green. Fix: bandLine strips every reset (regexp `\x1b\[0*m`) and paints the band once — tokens carry their own fg so resets are unneeded; swatch-dump verified one band SGR per row covering gutter+code+pad, lexerless files included. Second bug caught in the same dump: a run ending in a blank line fell back to PLAIN (chroma folds the trailing newline → row count one short) — padded back, regression test added. Bands darkened #1B4626/#4E2229. Lesson: assert on the RAW SGR stream, not ansiStrip'd text — the previous band test passed while the bands were visibly broken | (this commit) |
| 2026-09-25 | "Not colorful like grok" — two root causes, both found by dumping the raw SGR stream of a rendered diff: (1) the aurora token palette left identifiers/punctuation unstyled → terminal default → monochrome; replaced with VSCode Dark+ mapping (chroma's JS lexer emits `const` as plain Keyword → purple, not KeywordDeclaration-blue — assert against real lexer output, not assumed types). (2) bandLine injected the background once at line start, but the lipgloss gutter's own reset killed the band for the whole code portion — bands must be re-injected after EVERY `\x1b[0m` on the row. Bands brightened to #1A5A2D / #5F232D; regression test counts ≥2 band SGRs per banded line | (this commit) |
| 2026-09-25 | Grok-style write diffs (user picked Grok's screenshot over the +/- marker look): `renderDiffLines` rewritten — `@@` headers parsed for per-side line numbers (Sscanf bug of the day: forgot the pointer args, headers silently unparsed and rendered as content line 0), dim right-aligned gutter sized to the diff's largest number, full-width bands via `bandLine` SGR injection (hexDiffAddBg #17301F / hexDiffDelBg #3B1D21), headers and markers dropped, body flush left. Cap counts content only (header no longer drawn). 5 diff tests updated/added incl. multi-hunk gutter numbering; visual dump eyeballed | (this commit) |
| 2026-09-25 | VSCode-style diff highlighting + expandable output (user's two screenshots: flat-green write diff, "expandable to see details" errors). `internal/ui/highlight.go`: aurora chroma style (MustNewStyle + TTY16m formatter, verified against module source first), `highlightLines` lexes per run of same-kind diff lines, `renderDiffLines` re-attaches green/red markers; path plumbed to kindDiff via `diffChange{path,diff}` (live + replay). Expansion: `expanded` flag on uiMessage, `resultDetailBlock` (red non-bold errDetail body) + diffBlock's expanded mode, ctrl+o in handleKey base switch, clickExpand regions from messageViewport's new per-line message-index map (signature changed → two test callers updated; streamingBlock inlined and deleted, its test re-pointed at streamingIndex). Gotchas: adding a helpLine hint at position 5 made the drop-from-end loop eat esc/ctrl+c at width 100 and fail a popup test that keys off "stop stream" — least-critical hints go LAST; x/ansi.Truncate for clipping styled lines (clip() is rune-based and corrupts SGR). chroma + x/ansi indirect→direct, versions unchanged. 4 new tests incl. SGR-color assertions and a regions-based click toggle | (this commit) |
| 2026-09-25 | Readable tool calls + stray-bar fix (user's screenshot: `bash {"command":…}` JSON lines, "two vertical lines while thinking"). Root cause of the bars found by probing `renderMarkdown` + `answerBar` directly: glamour renders a raw that ends inside an open construct (```` ``` ````, `- `, `> `, `# `, `---`) as an empty final row → bar-only line in the SAME block (adjacent rows, no join gap — that's how it hid from block-level analysis). Fixes: `renderAnswer` strips trailing bar-only rows (via new production `stripANSI`; test helper delegates), empty/whitespace raw renders nothing, `ensureStreamingBlock`/`sealStreamingText` drop never-said-anything blocks (whitespace-only deltas are real), `streamingIndex` scan replaces `len-1` targeting (an early version sealed orphaned same-kind blocks and duplicated text — caught by the new orphan test before commit). Tool lines: `toolCallArgs` per-tool summaries, 200-char cap. 4 new ui tests, one old assertion updated (read call no longer shows JSON); frame dump eyeballed | (this commit) |
| 2026-09-25 | Git-style diffs for writes + streaming dedup (user: "render write ops like git diff" and "duplicate thinking lines, multiple vertical bars while thinking"): root cause of both thinking symptoms was `messageViewport` rendering streaming blocks twice (history loop + `streamingBlock()` at the live edge) — history loop now skips them; `tools.ChangeDiff` computes edit/write diffs from input alone (input-only by design: race-free live, stable on replay), new `kindDiff` block pairs the result summary with a colorized, width-clipped, 20-line-capped diff, call lines show path only for write-class tools, replay pairs call→result by id like todoCalls. An attempted guard suppressing `<think>` splitting after `reasoning_content` was reverted — `TestOpenAIThinkingStream` pins the dual channels as complementary, and the guard leaked tags into answers (gotcha recorded). Tests: TestChangeDiff + 4 ui tests (stream-once, live diff, error keeps plain result, replay diff) + frame dump eyeballed | (this commit) |
| 2026-09-25 | Fixed test-suite clobbering of the developer's real `~/.khode/config.json` (user: rebuilt khode and it came up "no api key / test-model"): `newTestModel` didn't isolate HOME, so any persisting-path test (`click_test` mode-picker apply, modepicker cycling, perm `/mode plan`) wrote the "test"/"test-model" fixture over the live config while tests stayed green (persist tests reload their own write). `isolateHome(t)` (HOME → temp dir + provider key envs cleared) now runs inside `newTestModel`; full suite verified by canary diff to leave `~/.khode` untouched; user's config restored to khateway defaults (clobbered copy kept at `~/.khode/config.json.clobbered-by-tests.bak`; khateway auth key was never touched) | (this commit) |
| 2026-09-25 | Live todo checklist (user asked for plan→todo→check-off like popular TUIs, picked the transcript panel): `DefaultSystemPrompt` teaches the workflow, plan approval result hands off to the todo list; ui `kindTodo` panel upserts in place at the live edge via the existing streaming-block mutation pattern, todo call lines suppressed, empty list clears, `full`/`fullResultBody` deleted; status line shows current task + done/total while streaming (reset on turn start/end/session switch); replay parses todo call inputs by id with `parseTodoRender` fallback for sanitized inputs; 6 new/updated ui tests + plan-approval + prompt tests | e4d8dd9 |
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
| 2026-09-22 | `/model` picker dialog (planned via ExitPlanMode; user picked centered dialog + fetch/refresh + type-to-filter): `modelpick.go` reuses `fetchModelsCmd`/`applyFetchedModels`/`listWindow`/dialog grammar, `cacheModelChoices` extracted for the three fetch consumers, completion row's args emptied for one-enter open. Verified: unit tests + tmux (open/filter/enter/esc/failure note/live header) + the full ui-battery 26/26. Two stumbles worth remembering: my first edit of the `/model` arm accidentally deleted the direct-set's Save+notice (caught only by tmux-probing against a pristine-main worktree after noticing the notice missing — the battery's `/model test-N` scroll section is the regression guard for that path), and the value-receiver resize trap hit the view tests a third time (uncaptured `Update(WindowSizeMsg)` left `starting…` on screen) | (this commit) |
| 2026-09-22 | User reported `/sessions` + esc quitting the TUI: `pickerKey` guessed the startup picker from `len(m.messages) > 1`, so any chat-opened picker over a young session (zero or one chat block — e.g. `/sessions` right after boot) took the quit branch. Fixed with an explicit `picker.startup` flag set only by the new `OpenStartupPicker` (main.go's `--resume` path); `OpenPicker` (slash command) always closes on esc. Tests pin both behaviors (`QuitMsg` asserted for startup esc, close+chat-visible for chat esc). Testing note: bare `--resume` as the last argv token errors with "flag needs an argument" (`resume` is a string flag; use `--resume=true`) — AGENTS.md's `./khode --resume` wording is misleading, and a full-screen program under tmux that exits instantly takes the whole tmux server down with it, which reads like a tmux failure | (this commit) |
| 2026-09-22 | User asked for a `/mcp` UI "as well" (planned via ExitPlanMode; user picked status+restart and per-server tool toggle): `mcp.go`'s `mcpPanel` mirrors `toolsPanel`, renders from live state only (`mcpClients` membership + registry prefix scans) so it never goes stale, reuses `applyMCPCmd` for enter-restart (dialog-side `busy` map cleared in `applyMCPResult`), and `space` maps all-on↔all-off onto the registry's session-scoped `SetEnabled`. Editing config stays in /settings (single source); the printed `mcpStatus()` is deleted. The reconcile semantics are worth knowing: `applyMCPCmd(restart)` starts EVERY configured-but-stopped server, not just the named one — enter on one dead server heals them all. tmux-verified with two deliberately broken stdio servers: unavailable rows, real fork/exec error surfaced as the mcp: chat notice, busy cleared, esc closes | (this commit) |
| 2026-09-22 | User pushed back: adding an MCP server belongs in `/mcp` directly. The settings form machinery was refactored host-agnostic — `formKey(msg, form)` and `commitForm(form)` now return `(cmd, flash, closed)` instead of writing `settings.savedMsg`/`settings.form` (a `saveConfig` helper split out of `saveSettings`), `newMCPServerForm`/`serverFormView` are shared constructors/renderers — and `mcpPanel` hosts the add form (`n`, its own `form`+`flash` fields, cursor lands on the saved row). The provider form's quirk that it never self-closes on commit was preserved. Gotcha: in a key-sequence test loop whose first key opens a form, the form swallows the rest — a stray second `n` types into the name field and silently changes the case under test. tmux-verified both hosts: add-from-dialog (persisted + reconciled + cursor on new row + ✓ flash) and the settings flow unchanged | (this commit) |
| 2026-09-23 | Wired khode to the deployed khateway (user request, config-only: `~/.khode/config.json` `base_urls.khateway` + `models.khateway`; built-in default stays localhost). Verified via a throwaway `cmd/livecheck` harness (deleted after) reusing khode's config+llm stack: deployed gateway accepts the anonymous key and routes, but its only registered model (`deepseek-v4.1-flash-free`) 504s on a stalled kiosapi.com upstream; the full streaming turn + usage was proven green against a local khateway instead. Khateway-side notes: the M15 remote DB (database_id `32583a0a…`) started an EMPTY local D1 — the old local state (kios-live-test provider + models) sat orphaned under the pre-M15 id and had to be row-copied; kiosapi.com's catalog dropped `glm-5.3-flash` (khode's KiosAPI model is now stale; `glm-5.3-flash-free` exists but stalls) while `north-mini-code` and `atria-dawn-preview` answer | (this commit) |
| 2026-09-23 | Instant mode switching mid-turn (planned via ExitPlanMode; user chose "leave stricter-mode dialogs open"): `Runner.Mode` → live `func() perm.Mode` (loop/task/app wiring + test `staticMode` helper), `permKey` shift+tab → `cycleMode` + `autoResolvePerm` (allow-direction-only self-approval, `KindTool` guard), dialog footer hint. Tests: mid-turn ask→accept-edits flip stops asking after one consult (agent), shift+tab auto-resolve / exec-ask-stays-open / plan-stays-manual (ui). The plan-dialog test initially assumed plan mode implied by the dialog — `newTestModel` starts in ask, so `setMode(ModePlan)` is needed up front | (this commit) |
| 2026-09-23 | Distinct agent-output UI (planned via ExitPlanMode; user picked accent bar + markdown-at-seal): `markdown.go` (aurora glamour theme, chroma forked from dark minus its gray slab, width-keyed renderer cache) + `answerBar`/`answerBarFinal` (2-col overhead const) + `uiMessage.final` through `block`/`finishStream`/`replayTranscript`; palette became hex constants shared by lipgloss and glamour; `colText` brightens streaming + sealed prose, `colResult` separates tool output from dim-italic thinking/system. Tests: themed render (ANSI present, no marker leaks, paragraph blank lines), bright/dim bar split, errored-turn exclusion, per-turn replay parity; two pre-existing raw-substring assertions fixed via `ansiStrip`. Verified: full gate green, python-pty smoke (boots to ready, clean ctrl+c), simulated-turn frame dump eyeballed | (this commit) |
| 2026-09-23 | Scrollable markdown dialogs + live streaming markdown (planned via ExitPlanMode; user chose live streaming md + both dialogs scrollable): `perm.go` grew `permBodyWidth`/`permBodyRows`/`dialogLines` (per text+width render cache)/`dialogWindow` (pad-to-width rows + `│`/`▐` gutter) and `permKey` scroll keys (`Model.permScroll`, reset on new dialog); plan dialog renders aurora markdown, tool dialog shows the untruncated diff (`colorizeDiff` takes width now, `clipPlain`/`permPreviewMax` deleted); `block()` streams through `renderMarkdown` with the cache write-back guarded on `!streaming` (fixes stuck cursors on mid-turn seals); aurora `Text` style dropped its color (glamour renders text as block⊕Text — Text's color was silencing heading/blockquote tints). Tests: scroll keys + scrollbar presence (`ansiStrip` assertions — glamour splits word pairs into separate runs), streaming-live + seal-correctness. Verified: full gate green, throwaway render of an overflowing plan dialog + streaming block eyeballed (debug test deleted) | (this commit) |
| 2026-09-23 | Wheel capture fix (user report from iTerm2: wheeling "out of the TUI" left the new plan-dialog scrollbar unreachable by wheel): `View()` declares `MouseModeCellMotion`, the `tea.MouseWheelMsg` case scrolls `permScroll` with a dialog open else `m.scroll` (`wheelStep` = 3, opposite directions — comment explains), stale "mouse is NOT captured" comments/test assertions replaced, `TestWheelScrolls` added (chat scroll, live-edge clamp, dialog scroll, chat untouched under dialog) | (this commit) |
| 2026-09-23 | User-vs-agent distinction (user picked the green slab over bar-twin and rounded-card mockups, shown as ASCII previews): `hexUserBg #123524` + `userCard` (Background + Padding(0,1)) + `Width(width)` render in `block()` so wrapped/blank lines all carry the band; `TestUserMessageRendersSlab` pins the SGR bg (`48;2;18;53;36`), the `❯`-inside-band layout, and one-line-per-paragraph structure. Eyeballed via throwaway render harness (deleted): band spans wrapped lines full-width, assistant bars unchanged | (this commit) |
| 2026-09-23 | Scrollbar fixes + mouse interaction (user report with screenshot: broken-looking bar, pgdn overshoot freezing the bottom, "make it wider and click/draggable"): glyphs unified to `██`/`░░` 2-cell gutter with `colDim` track, `scrollPerm` clamps via `len(m.permBodyLines())` (shared view/handler body builder; `permScrollMax` deleted), `mousePermClick`/`mousePermDrag` + `permDragging`/`permGrabOff` state with sb* geometry package vars recorded by `dialogWindow`/`renderPermBox`; tests: overshoot clamp, glyph presence, geometry-vs-drawn-glyphs, click/drag/release sequence | (this commit) |
| 2026-09-23 | User slab redesign (user screenshot: black-on-green text, full-width band): `userCard` gains `Foreground(colText)`, `block()` word-wraps at width−4 via `reflow/wordwrap` with a two-space hanging indent, clip guards long words, no `Width()` — the band hugs content. Test updated: light-foreground SGR, 4-line wrap structure, hang indent, ≤80-col hug | (this commit) |
| 2026-09-23 | Scrollbar cutoff fix (user screenshot + diagnosis): `planWrapSlack = 6` narrows the glamour wrap, `wrapOverflow` ANSI-aware re-wraps any line still wider than the body (chroma code blocks), `dialogWindow`'s pad gains `MaxWidth` so one logical line is one physical row; `TestPermScrollbarNoGapsWithOverflow` walks every window row asserting gutter presence with long list items + a 150-col code line | (this commit) |
| 2026-09-24 | Keyless removed from khode (user brief): internal/llm dropped `khatewayAnonKey`/`khatewayAccessSecret`/`x-khateway-access` (extraHeaders params gone from both client constructors; `khatewayUnauthenticatedPlaceholder` is construction-only), `config.KeyOptional` deleted so the pre-flight stops keyless khateway turns pointing at /login + /settings, the walkthrough gained the khateway access step (sign-in vs paste, both paths tested; sign-in dialog wins keys above welcome/settings, esc returns to the choice, approval → model step), the settings api-key row offers the same choice, build-release.sh bakes no secret; keyless-request + access-secret wire tests deleted, `TestNewKhatewayWithoutKey` pins the SDK-env-leak constraint at construction | (this commit) |
| 2026-09-24 | Baked the deployed khateway URL in as the built-in default (user: "khateway base url should be built-in; it's first class native"): `llm.DefaultKhatewayEndpoint` and `internal/khateway.DefaultBaseURL` → `https://khateway.chengsokdara.workers.dev/v1` (verified from ~/Apps/khateway wrangler.jsonc + curl: /health 200, keyless /v1/models 401); device_test origin expectation + a llm guard test updated; gitignore commit landed first (.zcode, .zcodeignore, khode-test binary) for a clean tree | (this commit) |
| 2026-09-24 | Walkthrough khateway-first + `/welcome` re-run (user: walkthrough must treat khateway as first choice; asked how to re-run it): providerChoices reorders khateway to the front with provIdx starting at 0, hint text says "khode native", `indexOf` helper deleted (cursor no longer seeks the configured provider — the ● marker still shows it); `/welcome` command + slashCommands row; walkthrough tests rewalked for the new order and `TestWelcomeCommandReopens` added | (this commit) |
| 2026-09-24 | Setup banner (user agreed esc shouldn't land in a silently dead chat): `Model.setupHint` renders warn-styled, width-clipped text first in chatView's mid band whenever `hasCredentials` fails or `cfg.Model()` is empty — khateway names /login, others /welcome + /settings; `TestSetupBannerShowsWhileUnconfigured` walks all three states | (this commit) |
| 2026-09-24 | Mouse + keyboard parity: `ui/click.go` region registry (stage → placeDialog flush; chatView bands shift their own), `handleKey` factored out of Update's KeyPressMsg case, footer chips/rows/forms/mode chips/banner commands/URL/more-notes wired across all overlays, welcome custom form gained a save row, chrome-budget row-count fix; tests: keyPress strings, listWindowAt staging, placeDialog geometry, end-to-end chip/row clicks through Update, 20-surface in-frame sweep; pty boot smoke clean | (this commit) |
| 2026-09-24 | Chat input + user-message UX (user screenshot: black-on-green slab; asked for prompt history + click-to-cursor): `userBar` green left rule replaces `userCard` (backgrounds deleted from the transcript entirely; test pins no-`48;`-bg + green bar + hang indent); `internal/ui/input.go`: ↑/↓ prompt recall (first/last-line gate via `LineInfo`, draft stash, consecutive-dedupe, transcript seeding in `replayTranscript` so resume/session-switch reseed) and click-to-cursor (`wrapRunes` mirrors bubbles' `wrap()` column-for-column, `hitToCursor` maps view cell → logical line/rune col with row-end clamps, `placeInputCursor` drives `MoveToEnd`/`CursorUp`/`SetCursorColumn`, `ScrollYOffset`-aware); chatView registers one region per input row. Verified: full gate green, `TestDumpViews` frame eyeballed (green ┃ ❯ text, zero bg codes), 12 new tests incl. end-to-end click through `View`+`MouseClickMsg` and a scrolled-input click | (this commit) |
| 2026-09-24 | Turn-hang hardening (user report: "working" for 6m on a khateway 504, felt infinite): `WithMaxRetries(0)` on both SDK clients (their hidden 2× retry multiplied every khode attempt), `DefaultRetryBudget` 45s wall-clock cap on khode's retry ladder (a 60s 504 spends it on attempt 1; fast failures still run the full 4-retry ladder — `TestAnthropicFastGatewayTimeoutsStillRetry` pins requests == 5, i.e. SDK retry stays off), 90s `streamStallLimit` watchdog (`stallGuard` in retry.go) canceling any attempt that produces no SSE events — surfaces "model stream stalled" instead of blocking `Next()` forever (user ctx vs attempt ctx distinguishes user-abort from stall), `insufficient_quota` 429s classified non-retryable. `llm.RetryEvent` (Attempt/Max/Err) forwarded by the loop, rendered as a clipped status-line note cleared on the next content event. Tests: budget-gate 504, quota 429, stall guard over a held-open SSE, RetryEvent announcement, ui status note. Separate commit: pre-existing flaky `TestHandshakeSendsInitialize` (serve goroutine wrote `s.requests` unsynchronized AND the assertion ignored the client's post-handshake initialized notification — failed ~30% of runs) — mutex + accessor + tolerant assertion, 20/20 green | (this commit) |
