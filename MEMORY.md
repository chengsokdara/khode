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

- **Working:** Phase 3 complete — on top of the Phase 1/2 TUI and provider
  layer, khode now runs an agent loop: `agent.Runner` streams a response,
  executes the model's tool calls (read/glob/grep via `internal/tools`),
  appends each result to the session, and re-streams until the model
  answers without tools (25-round cap, cancel-safe with paired
  tool_result lines). The `llm` contract carries `ToolDef` on requests,
  `ToolCalls`/`ToolResult` on messages, and `ToolCallEvent`/
  `ToolResultEvent` through the same event channel; both providers
  translate them (fake-SSE tested). The TUI shows `⏺ call` / `⎿ result`
  blocks, has `/tools`, and no longer writes the session — the loop owns
  all session writes. Sessions store tool lines (additive JSONL v2);
  resuming a tool-bearing transcript re-serializes to native wire blocks
  (verified E2E against a fake Anthropic SSE server, including resume).
- **Not yet started:** write tools (edit/write/bash), permission system,
  diff preview/approval, context compaction.

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

## Session log (append one entry per session)

| Date | Session summary | Commits |
|---|---|---|
| 2026-09-16 | Scaffolded repo; Phase 1 done (TUI + Anthropic streaming + sessions + docs) | baa7520 |
| 2026-09-16 | Phase 2 step 1: OpenAI provider via openai-go v1.12, `--provider` flag, fake-SSE provider test, docs | 7ae2922 |
| 2026-09-16 | Phase 2 step 2: `config.Provider` + per-provider `models` map with legacy migration, flags → overrides, config unit tests, docs | 3de9993 |
| 2026-09-16 | Phase 2 finished: cost estimate (c9cc6ab), named sessions + picker (50bfda7), config/Anthropic tests (af2faf7), docs | af2faf7 |
| 2026-09-16 | Phase 3: llm tool contract + provider translation (ecb9255), tools pkg (57c6c43), agent loop (a997292), UI wiring + tests (c3eac1a), docs | c3eac1a |
