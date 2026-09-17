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

- **Working:** Phase 5 complete — agent quality. `agent.SystemPrompt`
  composes the base prompt with project guidance: at every directory level
  from root to workdir, AGENTS.md is read (CLAUDE.md as fallback for that
  level), ancestors first, capped at 16 KiB, re-read every turn. Both
  providers retry transient stream failures (408/409/429/5xx/529, net
  timeouts, resets, truncated bodies) with exponential backoff honoring
  Retry-After — but only while zero content events were forwarded, so a
  retry can never duplicate visible output; after the first delta, errors
  surface unchanged. The `todo` tool (full-list replacement per call,
  in-memory, read-risk → usable in plan mode) keeps the model's task list;
  the TUI renders `todo` tool results in full (matched by event name)
  instead of the 2-line preview. The runner tracks exact input tokens from
  UsageEvents (char/4 estimates until the first arrives) and compacts when
  the conversation reaches 80% of `llm.ContextWindow(model)` (prefix
  table, conservative 128k default): `cutIndex` keeps the newest tail that
  fits 30% of the window and always lands on a user boundary (tool
  results never start a tail), an LLM call with the summarizer prompt in
  the system role (no tools advertised) condenses everything before the
  cut, the summary merges into the first kept user turn (no consecutive
  user messages), and `Session.Replace` rewrites the JSONL atomically
  (temp + rename). Compaction failures are swallowed — the turn continues
  uncompressed. `/compact` forces it; a `llm.CompactEvent` surfaces a
  notice in the TUI.
- **Not yet started:** Phase 6 — MCP client, subagents, plan mode, hooks.

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
