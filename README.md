# khode

A terminal-native coding assistant in the spirit of Claude Code — built in Go
with Bubble Tea.

## Status

Phase 1 (TUI chat + Anthropic streaming) — see [STATUS.md](STATUS.md) for the
phase checklist and [AGENTS.md](AGENTS.md) for architecture and conventions.

## Build & run

```sh
go build -o khode ./cmd/khode   # or: go run ./cmd/khode
export ANTHROPIC_API_KEY=sk-ant-...
./khode            # new session
./khode --resume   # continue the most recent session
```

State lives in `~/.khode/` (config, session transcripts).
