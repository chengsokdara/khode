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

- **Working:** Phase 1 complete — TUI chat with Anthropic streaming,
  markdown rendering (glamour), JSONL session persistence, `--resume`,
  slash commands (`/help`, `/new`, `/model`, `/exit`), token counter,
  esc-to-stop streaming. Phase 2: OpenAI provider works behind the same
  `llm.Provider`; provider + per-provider model now live in
  `config.json` (`"provider"`, `"models"`), flags are overrides only.
- **Not yet started:** cost estimate (price table), session picker,
  tools (read/glob/grep/bash/edit), permission system, agent tool loop,
  context compaction.

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

## Session log (append one entry per session)

| Date | Session summary | Commits |
|---|---|---|
| 2026-09-16 | Scaffolded repo; Phase 1 done (TUI + Anthropic streaming + sessions + docs) | baa7520 |
| 2026-09-16 | Phase 2 step 1: OpenAI provider via openai-go v1.12, `--provider` flag, fake-SSE provider test, docs | 7ae2922 |
| 2026-09-16 | Phase 2 step 2: `config.Provider` + per-provider `models` map with legacy migration, flags → overrides, config unit tests, docs | 3de9993 |
