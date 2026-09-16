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
- [x] **Phase 2 — Provider layer + polish**
  - [x] OpenAI provider behind the same `llm.Provider` interface
        (`openai/openai-go`); selection via a `--provider` flag for now
  - [x] Provider selection in config (`config.Provider` + per-provider
        model defaults), superseding the `--provider` flag default
  - [x] Cost estimate from a per-model price table
  - [x] Session picker / named sessions
  - [x] Unit tests for session + config (+ more provider translation
        cases; `llm` has fake-SSE tests for OpenAI and Anthropic)
- [x] **Phase 3 — Read-only tools + agent loop**
  - [x] `internal/tools`: `Tool` interface + registry
  - [x] `read`, `glob`, `grep` tools
  - [x] Agent loop: LLM decides tool calls, results fed back until done
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

Phase 3 complete: `internal/tools` (Tool interface, registry, read/glob/grep
with output caps) and an agent loop (`agent.Runner`) that streams, executes
the model's tool calls, feeds results back (25-round cap), and owns all
session writes. The TUI renders tool activity and drives turns through the
loop. Next up is Phase 4 — write tools + permissions.

## Next

1. `edit` (unique string-replacement), `write`, `bash` (timeout + output
   caps).
2. Permission modes: plan / ask / accept-edits / auto.
3. Diff preview + approval dialog in the TUI.

## Changelog

| Date | Change |
|---|---|
| 2026-09-16 | Phase 1: TUI chat + Anthropic streaming + sessions + docs | baa7520 |
| 2026-09-16 | OpenAI provider (`openai-go` v1.12) + `--provider` flag + fake-SSE provider test | 7ae2922 |
| 2026-09-16 | Provider selection in config: `provider` + per-provider `models` map, legacy migration, flags → overrides | 3de9993 |
| 2026-09-16 | Cost estimate from per-model price table (`llm.Price`, longest-prefix match, status-line `$`) | c9cc6ab |
| 2026-09-16 | Named sessions + `/sessions` picker + `--continue` / `--resume[=name]`, mtime-ordered listings | 50bfda7 |
| 2026-09-16 | Tests: config Load/Save (temp HOME) + Anthropic fake-SSE translation | af2faf7 |
| 2026-09-16 | Phase 3: tools in the llm contract (tool defs/calls/results/events, provider translation + fake-SSE tests) | ecb9255 |
| 2026-09-16 | Phase 3: `internal/tools` registry + read/glob/grep (stdlib `**` glob, output caps) | 57c6c43 |
| 2026-09-16 | Phase 3: agent loop (`agent.Runner`), session v2 tool lines, malformed-input hardening | a997292 |
| 2026-09-16 | Phase 3 finished: TUI tool activity + `/tools`, first ui tests, untrack junk files | c3eac1a |
