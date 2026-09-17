# khode

A terminal-native coding assistant in the spirit of Claude Code — built in Go
with Bubble Tea.

## Status

Phase 7 (configurable in the TUI) complete — see [STATUS.md](STATUS.md)
for the phase checklist and [AGENTS.md](AGENTS.md) for architecture and
conventions.

## Build & run

```sh
go build -o khode ./cmd/khode   # or: go run ./cmd/khode

./khode                         # new session
./khode --continue              # continue the most recent session
./khode --resume                # open the session picker
./khode --resume=fix-login-bug  # resume by name (unique prefix works)
```

No API key is required to launch. The first start opens `/settings` on
the api-key row: pick a provider with ←/→, paste your key, press enter —
it is stored in `~/.khode/auth.json` (owner-only) and you're done.
Setting `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment also
works and wins over the stored key.

## Configuration

Everything is configurable from inside the TUI with `/settings` (alias
`/config`) — no hand-editing of JSON:

- **provider** — `←`/`→` switches between anthropic and openai live
- **api key** — masked editor; stored per provider in `auth.json`
- **base url** — point a provider at a proxy or OpenAI-compatible
  endpoint
- **model** and **max tokens**
- **mode** — plan / ask / accept-edits / auto (same as `/mode`)
- **mcp servers** — add, edit, remove; changes apply live
- **hooks** — `pre_tool` / `post_tool` shell hooks; apply next turn

`--provider` and `--model` override the config for one session only.
Other commands: `/new [name]` (optionally named sessions), `/sessions`
(picker), `/model <name>`, `/compact`, `/mcp`, `/tools`, `/help`. The
status line shows a running cost estimate from a built-in per-model
price table; models it doesn't know display `$–`.
