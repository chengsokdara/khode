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
  calls `m.OpenSettings(ui.RowAPIKey)` for first-run setup (skipped when
  the `--resume` picker is showing), and `Model.hasCredentials` blocks
  submit and /compact with a "/settings" pointer instead of starting a
  turn that would 401. The `/settings` overlay (`internal/ui/
  settings.go`) edits provider, api key, base url, model, max tokens,
  mode, MCP servers, and hooks; provider and mode cycle with ←/→, text
  rows open masked `textinput` editors, and every commit saves
  immediately (config via `cfg.Save`, keys via `auth.Save`). A provider
  switch rebuilds `m.provider` and re-registers the task tool
  (`registerTaskTool`) because `SubagentConfig` captured the provider by
  value; in-flight turns keep the old client. MCP changes apply live:
  `applyMCPCmd` runs off the UI goroutine from `maps.Clone` snapshots,
  closes removed servers (`tools.RemoveMCP`), starts new ones
  (`mcp.Start` + `tools.AddMCP`), and force-restarts edited ones
  (command/env/risk are fixed at `mcp.Start`); results ride
  `mcpApplyMsg` into `applyMCPResult`, which moves clients into
  `Model.mcpClients` and reports in chat. Hook edits apply next turn (a
  fresh `hooks.Runner` is built per turn). `tools.Registry` gained an
  RWMutex — the agent loop reads it from its goroutine while the overlay
  mutates it. `Model.partial` is now a `*strings.Builder`; see Gotchas
  for why.
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

## Gotchas & lessons learned

- **anthropic-sdk-go ≥ v1.73**: no `anthropic.F()` wrappers, no
  `NewUserTextMessage`. Use `MessageNewParams{...}` plain fields,
  `anthropic.NewUserMessage(anthropic.NewTextBlock(s))`, and
  `stream.Current().AsAny()` type switches (`ContentBlockDeltaEvent` →
  `ev.Delta.AsAny().(anthropic.TextDelta)`).
- **glamour v1.0.0**: `glamour.NewRenderer` was removed → use
  `glamour.NewTermRenderer(...)` with the same option names.
- **bubbles v1.0.0 / bubbletea v1.3.10**: textarea `MaxHeight` exists;
  `KeyMsg.Alt` distinguishes plain Enter (send) from alt+enter (newline).
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
