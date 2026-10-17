# AGENTS.md — repo map

This file is the map for the khode product repo. Code lives in two trees. Read the `AGENTS.md` inside the tree you are changing before you edit it.

## Product

khode is a free coding agent plus the gateway that serves it. The client and the gateway are separate deployables that meet over HTTP. Do not merge them into one program, and do not add a shared library until a second client needs the same device-login or model-list code.

```
clients/khode        Go TUI. Module path stays `khode`. Commands run in this directory.
services/khateway    Cloudflare Worker. npm and wrangler run in this directory.
```

- Client work follows `clients/khode/AGENTS.md`, `clients/khode/RULES.md`, and `clients/khode/WORKFLOW.md`.
- Gateway work follows `services/khateway/AGENTS.md` and `services/khateway/RULES.md`.
- Each tree keeps its own `STATUS.md`, `ROADMAP.md`, and `MEMORY.md`. Update the one you changed.
- A new client is a new directory under `clients/`. A new model vendor is an adapter inside `services/khateway`.

## Checks

```sh
cd clients/khode && go build ./... && go vet ./... && gofmt -l . && go test ./...
cd services/khateway && npm run check && npm test
```

Never commit API keys. Client keys live in `~/.khode/auth.json`. Gateway secrets live in `.dev.vars` and Wrangler secrets, not in source.
