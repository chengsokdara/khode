# khode

A terminal-native coding assistant in the spirit of Claude Code — built in Go
with Bubble Tea.

## Status

Phase 7 (configurable in the TUI) complete — see [ROADMAP.md](ROADMAP.md)
for the phase checklist and backlog, [STATUS.md](STATUS.md) for the
current state, and [AGENTS.md](AGENTS.md) for architecture and
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
what khode is, pick a provider (Anthropic, OpenAI, khateway, or your own
endpoint), paste a key for the ones that need it, and for gateway/custom
endpoints pick a model from the freshly fetched list — then ends with
suggestions for what to try first (`enter` to start chatting, `esc`
skips). Keys are stored in `~/.khode/auth.json` (owner-only); setting
`ANTHROPIC_API_KEY` or `OPENAI_API_KEY` in the environment also works
and wins over the stored key. The status line tracks how full the
model's context window is (`ctx NN%`, warning-colored near the
auto-compact point).

## Configuration

Everything is configurable from inside the TUI with `/settings` (alias
`/config`) — no hand-editing of JSON:

- **provider** — `←`/`→` switches; `enter` opens the provider manager,
  where `n` adds a custom provider (name, protocol, base URL) for any
  OpenAI-compatible or Anthropic-protocol endpoint — Ollama, LM Studio,
  OpenRouter, proxies. New providers activate immediately and read
  `NAME_API_KEY`-style env vars if set. The built-in **khateway**
  provider points at a self-hosted [Khateway](https://github.com/) router
  and is keyless-native: pick it and start — no key step, the gateway
  fronts upstream auth (its endpoint shape picks the wire protocol
  automatically). Gateways that do check client keys accept
  `KHATEWAY_API_KEY` as an optional override.
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
(picker), `/model <name>`, `/compact`, `/mcp`, `/tools`, `/help`.
Typing `/` opens a completion popup above the input that filters the
command list as you type — ↑/↓ picks, enter runs, tab just fills, esc
dismisses. The status line shows how full the model's context window
is (`ctx NN%`, warning near auto-compact) and a running cost estimate
from a built-in per-model price table; models it doesn't know display
`$–`.

## Development

The inner loop is plain Go: edit, `go build ./... && go vet ./...`,
`go test ./...`, then `go build -o khode ./cmd/khode && ./khode` and
exercise the change in the live TUI. There is no separate production
build — the binary you run in development is the binary, and
`~/.khode/` state is shared, so use `--resume` to get back to a session
you were debugging.

Provider behavior is tested wire-level: the fake-SSE tests
(`internal/llm/*_test.go`) run real HTTP against `httptest` servers
speaking Anthropic/OpenAI SSE, so streaming, tool calls, thinking
blocks, and retries are covered without a key or network. To point a
*running* khode at a fake or local endpoint instead, set
`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` / `KHATEWAY_BASE_URL` (or the
base-url row in `/settings`).

**Debugging the TUI:** printing to the terminal from inside a Bubble Tea
app corrupts the screen, so `--debug` redirects the standard logger to
`khode-debug.log`:

```sh
./khode --debug                 # in another terminal:
tail -f khode-debug.log         # turn starts, tool calls, permission decisions
```

`internal/debug.Printf` is the only sanctioned logging call — it compiles
to a no-op unless `--debug` is on. For breakpoints, delve works fine
with TUI programs (the UI just freezes while you inspect):
`dlv debug ./cmd/khode -- --continue`. TUI behavior itself is verified
through the `Model.Update`/`View` unit tests in `internal/ui` rather
than screen-scraping.
