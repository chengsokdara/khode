# khode

A terminal-native coding assistant in the spirit of Claude Code — built in Go
with Bubble Tea.

## Status

Phase 3 (read-only tools + agent loop) complete — see [STATUS.md](STATUS.md)
for the phase checklist and [AGENTS.md](AGENTS.md) for architecture and
conventions.

## Build & run

```sh
go build -o khode ./cmd/khode   # or: go run ./cmd/khode
export ANTHROPIC_API_KEY=sk-ant-...    # or OPENAI_API_KEY for openai

./khode                         # new session
./khode --continue              # continue the most recent session
./khode --resume                # open the session picker
./khode --resume=fix-login-bug  # resume by name (unique prefix works)
```

## Providers, models, config

State lives in `~/.khode/` (config + `sessions/*.jsonl`). Config defaults
apply per provider, and each provider remembers its own last-used model:

```json
{
  "provider": "anthropic",
  "models": { "anthropic": "claude-sonnet-4-5", "openai": "gpt-5-mini" },
  "max_tokens": 8192
}
```

`--provider` and `--model` override the config for one session only.
Inside the TUI: `/new [name]` (optionally named sessions), `/sessions`
(picker), `/model <name>` (persisted), `/help`. The status line shows a
running cost estimate from a built-in per-model price table; models it
doesn't know display `$–`.
