# khode

A free coding agent and the gateway that serves it. The terminal client runs on your machine. Khateway holds the account, the key, the credits, and the route to each model.

## Layout

Two deployables. They share an HTTP contract, not a library. The client is Go. The gateway is a Cloudflare Worker with its own database, admin UI, and billing. One process would tie a local TUI to a multi-tenant edge service, so they stay separate and deploy separately.

```
clients/khode        terminal agent (Go module `khode`)
services/khateway    accounts, keys, credits, model routing
```

A later client (an editor plugin, a web app) is another directory under `clients/`. It talks to Khateway the same way the CLI does: device sign-in, then `/v1`. There is no shared Go/TypeScript package until a second client needs the same device-login or model-list code. Until then, `services/khateway` is the contract and `clients/khode` is the reference client.

Provider adapters stay inside the gateway. A new model vendor is a gateway change, not a new client.

## Build

```sh
cd clients/khode && go build -o khode ./cmd/khode
cd services/khateway && npm install && npm run dev
```

The CLI ships pointed at `https://khateway.chengsokdara.workers.dev/v1`. `/login` is device sign-in. A key and a prepaid balance are required. Client details are in [`clients/khode/README.md`](clients/khode/README.md). Gateway setup, Turnstile, and deploy are in [`services/khateway/README.md`](services/khateway/README.md).

GLM-5.3 and GLM-5.3-Flash think on every turn. The client sends that trace back as `reasoning_content`. Register those models on a paid NVIDIA NIM provider in the gateway, not on the free-tier importer.
