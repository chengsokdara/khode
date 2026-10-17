# ROADMAP.md — Phases & Backlog

Where khode is headed. The checklist below records the shipped phases
(kept as the milestone record); **Next** is the working backlog. Tick
items and update **Next** here when the plan moves (see `RULES.md`);
`STATUS.md` carries the one-glance current state and the changelog.

## Completed phases

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
        (SUPERSEDED 2026-09-24: khateway keyless support removed —
        sign-in `/login` or a real key required; the pre-flight check
        itself stays)
  - [x] `/settings` overlay: provider (live switch), api key, base
        url, model, max tokens, mode — every row saves on commit
  - [x] MCP servers + hooks edited in the TUI; MCP servers started,
        stopped, and restarted live from the overlay

## Next

Shipped 2026-10-17: the client and the gateway are siblings
(`clients/khode`, `services/khateway`). No shared package. Shipped
2026-10-16, outside this backlog: GLM-5.3 tool
turns replay `reasoning_content` with `max_tokens` and a default
`reasoning_effort` of high. Publishing the GitHub repo, registering the
NIM models at real prices, and a live tool loop are operator steps and
are not done.

Backlog (no committed order):

1. ~~Stream subagent activity into the TUI instead of hiding it.~~
   (done — task tool progress feeds a live nested line under the call)
2. ~~MCP: re-list tools on `tools/list_changed`~~ (done — the client's
   pump forwards notifications through a `SetNotify` hook, the UI
   re-lists into the registry live, and the diff is reported in chat;
   refresh no longer means a restart). Resources/prompts remain open.
3. ~~Hooks: feed post_tool output to the model as feedback.~~
   (done — a hook's exit-0 stdout / exit-2 stderr is appended to the
   call's tool result inside `<hook-feedback>` tags, capped at 8 KiB,
   all matching hooks joined; other exits stay silent)
4. OpenAI tool-call unit parity for MCP edge cases as they surface.
5. Khode /terminal-setup: write the Terminal.app/iTerm2 shift+enter
   mapping khode's alt+enter fallback already picks up.
6. ~~Subagents, continued~~ (done): automatic new-session context
   gatherer and `Runner.Preface`, `subagent_model`, user-defined agents
   (`~/.khode/agents/*.md`), a code-reviewer kind, an `/agents` overview
   command, and parallel read-only fan-out (consecutive read-only calls
   run as a bounded parallel group; all-read task children spawn side
   by side).
7. ~~Queue prompts mid-turn~~ (done): enter while a turn streams files
   the prompt instead of swallowing it — a queued band shows the head
   of the line, turn end auto-submits FIFO, esc hands the queue back to
   the input, and slash commands wait with an explicit note.
