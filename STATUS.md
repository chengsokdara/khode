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
- [x] **Phase 4 — Full agent (write tools + permissions)** ⭐ milestone
  - [x] `edit` (unique string-replacement), `write`, `bash` (timeout +
        output caps)
  - [x] Permission modes: plan / ask / accept-edits / auto
  - [x] Diff preview + approval dialog in the TUI
- [x] **Phase 5 — Agent quality**
  - [x] AGENTS.md-style project context in system prompt
  - [x] Context compaction when nearing the token window
  - [x] Todo tracking tool, API retry/backoff
- [x] **Phase 6 — Advanced**
  - [x] MCP client (stdio JSON-RPC, no SDK): `mcp_servers` config,
        tools registered as `mcp__<server>__<tool>`, per-server risk
        override, `/mcp` status
  - [x] Subagents: `task` tool runs a fresh Runner on an in-memory
        session and returns the final report
  - [x] Plan mode workflow: `plan` tool presents a plan, approval in
        the TUI switches to accept-edits
  - [x] Hooks: `pre_tool` (veto with exit 2) and `post_tool` shell
        hooks from config
- [x] **Phase 7 — Configurable in the TUI**
  - [x] API keys in `~/.khode/auth.json` (0600, atomic write); env
        vars still win (`llm.Resolve`)
  - [x] Keyless startup: no env gate; with no credentials anywhere the
        settings overlay opens on the api-key row; pre-flight check
        stops keyless turns with a pointer to `/settings`
  - [x] `/settings` overlay: provider (live switch), api key, base
        url, model, max tokens, mode — every row saves on commit
  - [x] MCP servers + hooks edited in the TUI; MCP servers started,
        stopped, and restarted live from the overlay

## Now

Phase 7 complete — nothing in khode needs hand-editing config.json.
First run (no credentials anywhere) opens a walkthrough overlay, not
settings: intro card → pick provider (←/→, saved live) → paste the API
key (masked, into auth.json) → a ready card ending in an explicit
"enter to start chatting"; esc skips any step. `/settings` (alias
`/config`) remains the full editor — every row persists the moment it
commits and its footer keys render highlighted. Custom providers
(Ollama, OpenRouter, proxies — anything OpenAI-compatible or speaking
the Anthropic protocol) are managed in the provider list on the
provider row: `n` adds one (name, protocol, base URL), and it
activates immediately; credentials resolve through
`config.Credentials` with `<NAME>_API_KEY`-style env overrides. The
model row opens a picker that fetches the endpoint's model list (real
HTTP per protocol, off the UI goroutine), caches it in
`model_choices`, and falls back to manual add (n) when the endpoint
can't list; customs never inherit a built-in default model — an unset
model blocks the turn with a pointer to the picker. The status line
shows the context meter "ctx NN%" (warning at the 80% auto-compact
trigger). Provider names keep the casing they were saved with —
custom-provider, models, model-choice, and auth-key lookups fall back
to case-insensitive matching, and Load snaps the active name to the
stored custom-provider key; a protocol that still doesn't resolve
warns at startup and falls back to the anthropic client instead of
exiting. The chat input drops bubbles' hard black cursor-line
background, which rendered as a black strip inside the input box on
dark terminal themes. Keys live in `~/.khode/auth.json` (0600, atomic
rename) with env vars keeping precedence. MCP changes apply live via
`applyMCPCmd`; hook edits apply next turn. The registry has an RWMutex
(agent loop reads it while the overlay mutates it); `Model.partial` is
a pointer `strings.Builder` (see Gotchas).

## Next

Backlog (no committed order):

1. Stream subagent activity into the TUI instead of hiding it.
2. MCP: re-list tools on `tools/list_changed`; resources/prompts.
3. Hooks: feed post_tool output to the model as feedback.
4. OpenAI tool-call unit parity for MCP edge cases as they surface.

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
| 2026-09-17 | Phase 4: edit/write/bash tools + LCS diff helper (`UnifiedDiff`, `DiffStat`) | 2c277fa |
| 2026-09-17 | Phase 4: `internal/perm` modes × risk decisions, config field, agent-loop gate + `Approver`/`Bridge` | 557bafe |
| 2026-09-17 | Phase 4 finished: TUI approval dialog with diff/command preview, `/mode`, docs | f1483c7 |
| 2026-09-17 | Phase 5: AGENTS.md/CLAUDE.md project context in the system prompt (`agent.SystemPrompt`) | f1c8f78 |
| 2026-09-17 | Phase 5: transient-failure retry with backoff in both providers (no retry after content) | 5d441f3 |
| 2026-09-17 | Phase 5: `todo` task-list tool, rendered whole in the TUI | bc422f2 |
| 2026-09-17 | Phase 5: context compaction (80% trigger, clean-boundary cut, atomic rewrite) + `llm.ContextWindow` + `/compact` | 98eccb1 |
| 2026-09-17 | Phase 6: MCP stdio client + `mcp_servers` config + registry bridge + `/mcp` | 1af8588 |
| 2026-09-17 | Phase 6: `task` subagent tool on in-memory sessions | 0d21ba2 |
| 2026-09-17 | Phase 6: `plan` tool + plan-approval dialog → accept-edits | 94d1049 |
| 2026-09-17 | Phase 6: pre/post tool-use hooks with pre_tool veto | 698ffba |
| 2026-09-17 | Phase 7: auth.json key store (0600, atomic) + `base_urls`; llm keyed constructors + factory; registry RWMutex + RemoveMCP | b46b15f |
| 2026-09-17 | Phase 7: `/settings` overlay, keyless startup + first-run setup, live MCP apply | 2351355 |
| 2026-09-17 | Phase 7: first-run walkthrough, highlighted overlay exits, status-line context meter | 3265b34 |
| 2026-09-17 | Phase 7: custom providers (any OpenAI/Anthropic-protocol endpoint), model-list fetching with manual fallback | 002796f |
| 2026-09-17 | Phase 7: custom providers in the first-run walkthrough (inline add form) | 6a25702 |
| 2026-09-17 | Fix: provider names keep their casing (case-insensitive lookups), bad protocol warns + falls back at startup, chat input's black cursor-line strip removed | 557a92a d4426e0 |
