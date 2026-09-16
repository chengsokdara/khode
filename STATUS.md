# STATUS.md — Progress Tracker

One-glance project state. Update at the end of **every** task (see
`RULES.md`). Historical detail belongs in `MEMORY.md`, not here.

## Roadmap

- [x] **Phase 0/1 — Skeleton chat (TUI + Anthropic streaming)**
  - [x] Go module, repo init, `.gitignore`, README
  - [x] `internal/llm` provider abstraction (`Provider`, `Event` channel)
  - [x] Anthropic provider (streaming, usage, cancellation)
  - [x] Bubble Tea app: viewport chat, textarea input (grow 1→6 lines),
        spinner status bar, token counter, help line
  - [x] glamour markdown rendering of completed replies
  - [x] JSONL session persistence + `--resume`
  - [x] Slash commands: `/help`, `/new`, `/model <name>` (persisted),
        `/exit`
  - [x] Esc stops an in-flight stream; Ctrl+C quits
- [ ] **Phase 2 — Provider layer + polish**
  - [x] OpenAI provider behind the same `llm.Provider` interface
        (`openai/openai-go`); selection via a `--provider` flag for now
  - [ ] Provider selection in config (`config.Provider` + per-provider
        model defaults), superseding the `--provider` flag default
  - [ ] Cost estimate from a per-model price table
  - [ ] Session picker / named sessions
  - [ ] Unit tests for session + config (+ more provider translation
        cases; `llm` already has a fake-SSE OpenAI test)
- [ ] **Phase 3 — Read-only tools + agent loop**
  - [ ] `internal/tools`: `Tool` interface + registry
  - [ ] `read`, `glob`, `grep` tools
  - [ ] Agent loop: LLM decides tool calls, results fed back until done
- [ ] **Phase 4 — Full agent (write tools + permissions)** ⭐ milestone
  - [ ] `edit` (unique string-replacement), `write`, `bash` (timeout +
        output caps)
  - [ ] Permission modes: plan / ask / accept-edits / auto
  - [ ] Diff preview + approval dialog in the TUI
- [ ] **Phase 5 — Agent quality**
  - [ ] AGENTS.md-style project context in system prompt
  - [ ] Context compaction when nearing the token window
  - [ ] Todo tracking tool, API retry/backoff
- [ ] **Phase 6 — Advanced**
  - [ ] MCP client, subagents, plan mode, hooks

## Now

Phase 2 in flight: OpenAI provider committed and tested; next is moving
provider selection into config.

## Next

1. Provider selection: `config.Provider` + per-provider model defaults;
   `cmd/khode` flag becomes an override.
2. Cost estimate from a per-model price table.
3. Tests for `agent.Session` and `config.Load/Save`.

## Changelog

| Date | Change |
|---|---|
| 2026-09-16 | Phase 1: TUI chat + Anthropic streaming + sessions + docs | baa7520 |
| 2026-09-16 | OpenAI provider (`openai-go` v1.12) + `--provider` flag + fake-SSE provider test | — |
