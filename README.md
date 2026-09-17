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

No API key is required to launch. The first start walks you through it —
what khode is, pick a provider, paste a key — and ends with suggestions
for what to try first (`enter` to start chatting, `esc` skips). Keys are
stored in `~/.khode/auth.json` (owner-only); setting `ANTHROPIC_API_KEY`
or `OPENAI_API_KEY` in the environment also works and wins over the
stored key. The status line tracks how full the model's context window
is (`ctx NN%`, warning-colored near the auto-compact point).

## Configuration

Everything is configurable from inside the TUI with `/settings` (alias
`/config`) — no hand-editing of JSON:

- **provider** — `←`/`→` switches; `enter` opens the provider manager,
  where `n` adds a custom provider (name, protocol, base URL) for any
  OpenAI-compatible or Anthropic-protocol endpoint — Ollama, LM Studio,
  OpenRouter, proxies. New providers activate immediately and read
  `NAME_API_KEY`-style env vars if set. The built-in **khateway**
  provider points at a self-hosted [Khateway](https://github.com/) router:
  one base URL + one client key unlock every model the gateway exposes
  (its endpoint shape picks the wire protocol automatically).
- **api key** — masked editor; stored per provider in `auth.json`
- **base url** — point a provider at a proxy or OpenAI-compatible
  endpoint
- **model** — opens a picker that fetches the provider's model list
  from its endpoint (`f` re-fetches); if the endpoint can't list
  models, `n` adds one manually
- **max tokens**
- **mode** — plan / ask / accept-edits / auto (same as `/mode`)
- **mcp servers** — add, edit, remove; changes apply live
- **hooks** — `pre_tool` / `post_tool` shell hooks; apply next turn

`--provider` and `--model` override the config for one session only.
Other commands: `/new [name]` (optionally named sessions), `/sessions`
(picker), `/model <name>`, `/compact`, `/mcp`, `/tools`, `/help`. The
status line shows how full the model's context window is (`ctx NN%`,
warning near auto-compact) and a running cost estimate from a built-in
per-model price table; models it doesn't know display `$–`.
