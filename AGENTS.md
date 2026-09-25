# AGENTS.md — Instructions for AI Agents

This file is for any AI agent (or human contributor) working in this repo.
Read it before writing code. Read `RULES.md` for hard rules. Read `WORKFLOW.md`
for the build-and-verify loop (TUI features self-test in a live TTY — no user
screenshots). Read `STATUS.md`, `ROADMAP.md`, and `MEMORY.md` to find out
where the project stands.

## What khode is

khode is a terminal-native coding assistant (Claude Code style) built in Go
with Bubble Tea. Long-term it becomes a full agentic coding tool: it can read,
edit, and run code in the user's project behind a permission system.

## Stack

- **Language:** Go (≥ 1.27), standard library layout (`cmd/`, `internal/`)
- **TUI:** [bubbletea](https://github.com/charmbracelet/bubbletea) (Elm
  architecture) + bubbles (textarea, viewport, spinner) + lipgloss
- **Markdown:** glamour v1 (`glamour.NewTermRenderer`, not the removed
  `NewRenderer`)
- **LLM:** official SDKs behind our own abstraction
  - Anthropic: `github.com/anthropics/anthropic-sdk-go` (v1.73+ style:
    plain param fields, no `anthropic.F()` wrappers)
  - OpenAI: planned (`openai/openai-go`)
  - Khateway: built-in provider speaking to a self-hosted Khateway
    router through one of the two SDK clients (endpoint shape decides;
    see `internal/llm/khateway.go`)

## Architecture

```
cmd/khode/           entry point: flags, config, session setup, tea.Program
internal/config/     user-level state
  config.go            ~/.khode/config.json load/save (+ base_urls, custom_providers)
  auth.go              ~/.khode/auth.json API-key store (0600, atomic)
  provider.go          custom providers, credential resolution (env > stored), model choices
internal/llm/        provider-agnostic contract
  provider.go          Message, Request, Event, Provider interface
  anthropic.go         Anthropic SDK → Event channel translation
  openai.go            OpenAI SDK → Event channel translation
  factory.go           llm.New/NewProtocol (protocol + display name), env-name helpers gone to config
  khateway.go          built-in khateway router provider: endpoint-shape → protocol resolution;
                       sign-in (/login device flow) or a real client key required — no keyless path
  models.go            FetchModels: model-list HTTP APIs per protocol
  retry.go             shared retry policy (transient failures, backoff)
  context.go           per-model context-window table
  pricing.go           per-model price table
internal/khateway/   khateway device-flow client (RFC 8628): Start/Poll → personal
                       API key (sentinels ErrPending/ErrDenied/ErrExpired); used by
                       the /login dialog
internal/perm/       permission policy: modes × risk classes → allow/ask/deny
internal/tools/      tools (read, glob, grep, edit, write, bash, todo) + Registry
internal/mcp/        minimal MCP client (stdio JSON-RPC): initialize, tools/list, tools/call
internal/hooks/      user lifecycle hooks around tool calls (pre_tool veto, post_tool)
internal/agent/      conversation machinery
  session.go           JSONL transcript (source of truth for LLM history)
  loop.go              agent loop: stream → gated tool calls → results → stream
                       (Runner.Preface writes a <task-context> brief ahead of the turn)
  compact.go           context compaction: summarize near the token window
  context.go           AGENTS.md/CLAUDE.md project context for the system prompt
  approve.go           Approver interface + Bridge carrying tool/plan questions
  subagent.go          subagent kind catalog: general-purpose / explore / context-gatherer
                       / plan — per-kind toolset (read-only kinds get read/glob/grep),
                       system section, and report cap
  task.go              subagent task tool (subagent_type + description + prompt; fresh
                       in-memory session, progress feed to the UI, report back)
  plan.go              plan tool: present a plan, approval switches to accept-edits
                       and hands the plan off to the todo list
internal/ui/         Bubble Tea app
  app.go               root Model, agent-loop wiring, slash commands,
                       live todo checklist panel (one upserted panel + status-line task),
                       live subagent activity lines, first-prompt context gatherer
                       (◆ gathering context → ◆ context brief → Runner.Preface turn)
  devicelogin.go       /login overlay: khateway device sign-in (mint → show URL+code →
                       poll → key into auth.json, khateway active, model auto-pick)
  modepicker.go        shift+tab mode cycling, /mode picker, mode line above the input
  perm.go              approval dialog (diff preview) + plan dialog
  picker.go            session picker overlay
  settings.go          /settings overlay: keys, provider, model, mode, MCP, hooks
  welcome.go           first-run walkthrough: intro → provider → key → ready
  click.go             mouse click targets: regions recorded at render time,
                       hit-tested on press; chips synthesize their key
  styles.go            lipgloss palette
```

### Key patterns (do not break these)

1. **Provider-agnostic core.** The agent loop and UI only know
   `llm.Message` / `llm.Request` / `llm.Event` / `llm.Provider`. Provider
   SDKs are only ever imported inside `internal/llm/<provider>.go`.
2. **Channel-based streaming.** `Provider.Stream` returns `<-chan Event`
   and must send `DoneEvent` (or `ErrorEvent`) before closing the channel.
   `agent.Runner.Run` follows the same contract for a whole turn: its
   channel ends with exactly one turn-level DoneEvent/ErrorEvent.
3. **TUI ↔ goroutine bridge.** Streaming runs in a goroutine; the UI
   consumes it via the `waitForEvents` command chain (one blocking
   `<-ch` read per message), never by holding a `*tea.Program`. The
   permission bridge rides the same select: the loop blocks in
   `Bridge.Approve`, the UI answers via `Request.Answer` (buffered, so a
   late answer can never block).
4. **Session is truth.** `agent.Session` (JSONL, append-only, synced per
   turn) is what gets sent back to the LLM. Only the agent loop writes
   the session; the UI message list is for display only; UI-only notices
   use role `"system"` and `history=false` semantics (never appended).
5. **Elm architecture.** All state mutation happens in `Model.Update`;
   views are pure. Keep it that way.

## Commands

```sh
go build ./...          # compile everything (must pass before any commit)
go vet ./...            # static checks
gofmt -w .              # formatting (no disputes — gofmt is law)
go build -o khode ./cmd/khode && ./khode   # run
./khode --resume        # continue latest session
go test ./...           # tests (add them as packages grow)
scripts/build-release.sh   # official release build (plain cross-compile — no
                           # secrets are baked; `all` cross-compiles)
scripts/tmux-selftest.sh   # run khode against a scripted fake model in a real
                           # tmux TTY (isolated socket) and capture the frames —
                           # self-verify TUI features instead of asking the user
```

khateway sign-in: `/login` runs the device flow — a short code is shown,
the user approves it at the gateway's `/app/device` page, and khode banks
the personal API key it returns (stored like any key in
`~/.khode/auth.json`). Sign-in or a pasted key are the only ways to use
khateway: the deployed gateway rejects every request without a valid
client key. Never commit keys or secrets.

Env: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `KHATEWAY_API_KEY` (and
`*_BASE_URL`) win when set; otherwise keys come from
`~/.khode/auth.json`, saved by `/settings` or the walkthrough. With no
key, khode starts anyway and opens settings on the api-key row; a turn
without a key is stopped by a pre-flight check instead of failing on a
401 — for khateway that check points at `/login` too. State lives in
`~/.khode/` (config, auth, `sessions/*.jsonl`). Never commit API keys,
and never put them in `config.json` — that file must stay shareable.
Subagent knobs: `gather_context` (default on) runs the read-only
context-gatherer on the first prompt of a fresh session; `subagent_model`
(empty = main model) runs task subagents and the gatherer on a
faster/cheaper model. Both are `/settings` rows.

## Conventions

- Comments start with the thing they describe, full sentences, no
  restating of the obvious.
- Errors: wrap with context (`fmt.Errorf("reading config: %w", err)`).
  Return errors; don't log-and-continue inside libraries.
- TUI messages: `<thing>Msg` suffix (`streamEventMsg`, `streamClosedMsg`).
- Keep `internal/` packages free of `main` concerns; `cmd/khode` does I/O
  wiring only.
- New provider = new file in `internal/llm/` implementing `Provider` +
  a constructor + wiring in `cmd/khode`. Nothing else changes.

## Definition of done (every task)

1. `go build ./...`, `go vet ./...`, `gofmt -l .` are all clean.
2. Behavior manually verified where tests can't cover it (TUI flows).
3. Docs synced per `RULES.md` (STATUS.md + ROADMAP.md + MEMORY.md).
4. Work committed with a clear message.
