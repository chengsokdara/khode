# AGENTS.md — Instructions for AI Agents

This file is for any AI agent (or human contributor) working in this repo.
Read it before writing code. Read `RULES.md` for hard rules. Read `STATUS.md`
and `MEMORY.md` to find out where the project stands.

## What khode is

khode is a terminal-native coding assistant (Claude Code style) built in Go
with Bubble Tea. Long-term it becomes a full agentic coding tool: it can read,
edit, and run code in the user's project behind a permission system.

## Stack

- **Language:** Go (≥ 1.27), standard library layout (`cmd/`, `internal/`)
- **TUI:** [bubbletea](https://github.com/charmbracelet/bubbletea) (Elm
  architecture) + bubbles (textarea, viewport, spinner) + lipgloss
- **Markdown:** glamour v1 (`glamour.NewTermRenderer`, not the removed
  `NewRenderer`)
- **LLM:** official SDKs behind our own abstraction
  - Anthropic: `github.com/anthropics/anthropic-sdk-go` (v1.73+ style:
    plain param fields, no `anthropic.F()` wrappers)
  - OpenAI: planned (`openai/openai-go`)

## Architecture

```
cmd/khode/           entry point: flags, config, session setup, tea.Program
internal/config/     ~/.khode/config.json load/save
internal/llm/        provider-agnostic contract
  provider.go          Message, Request, Event, Provider interface
  anthropic.go         Anthropic SDK → Event channel translation
internal/agent/      conversation machinery
  session.go           JSONL transcript (source of truth for LLM history)
internal/ui/         Bubble Tea app
  app.go               root Model, streaming wiring, slash commands
  styles.go            lipgloss palette
```

### Key patterns (do not break these)

1. **Provider-agnostic core.** The agent loop and UI only know
   `llm.Message` / `llm.Request` / `llm.Event` / `llm.Provider`. Provider
   SDKs are only ever imported inside `internal/llm/<provider>.go`.
2. **Channel-based streaming.** `Provider.Stream` returns `<-chan Event`
   and must send `DoneEvent` (or `ErrorEvent`) before closing the channel.
3. **TUI ↔ goroutine bridge.** Streaming runs in a goroutine; the UI
   consumes it via the `waitForEvents` command chain (one blocking
   `<-ch` read per message), never by holding a `*tea.Program`.
4. **Session is truth.** `agent.Session` (JSONL, append-only, synced per
   turn) is what gets sent back to the LLM. The UI message list is for
   display only; UI-only notices use role `"system"` and `history=false`
   semantics (never appended to the session).
5. **Elm architecture.** All state mutation happens in `Model.Update`;
   views are pure. Keep it that way.

## Commands

```sh
go build ./...          # compile everything (must pass before any commit)
go vet ./...            # static checks
gofmt -w .              # formatting (no disputes — gofmt is law)
go build -o khode ./cmd/khode && ./khode   # run
./khode --resume        # continue latest session
go test ./...           # tests (add them as packages grow)
```

Env: `ANTHROPIC_API_KEY` must be set to talk to Anthropic. State lives in
`~/.khode/` (config + `sessions/*.jsonl`). Never commit API keys.

## Conventions

- Comments start with the thing they describe, full sentences, no
  restating of the obvious.
- Errors: wrap with context (`fmt.Errorf("reading config: %w", err)`).
  Return errors; don't log-and-continue inside libraries.
- TUI messages: `<thing>Msg` suffix (`streamEventMsg`, `streamClosedMsg`).
- Keep `internal/` packages free of `main` concerns; `cmd/khode` does I/O
  wiring only.
- New provider = new file in `internal/llm/` implementing `Provider` +
  a constructor + wiring in `cmd/khode`. Nothing else changes.

## Definition of done (every task)

1. `go build ./...`, `go vet ./...`, `gofmt -l .` are all clean.
2. Behavior manually verified where tests can't cover it (TUI flows).
3. Docs synced per `RULES.md` (STATUS.md + MEMORY.md).
4. Work committed with a clear message.
