# RULES.md — Hard Rules for AI Agents

These are non-negotiable. They exist so that any agent can trust the docs
and build on prior sessions without re-verifying everything.

## 1. Doc sync on task completion (mandatory)

At the end of **every task, and at the end of every session** (including
interrupted ones, as the last action before stopping):

1. **`STATUS.md`** — update **Now** (what is in flight) and add a
   **Changelog** row with today's date.
2. **`ROADMAP.md`** — tick completed phase checklist items and update
   **Next** when the plan shifts.
3. **`MEMORY.md`** — append any new decisions (with a one-line why), any
   gotchas discovered (SDK quirks, build traps), and add a **Session log**
   row summarizing what you did and the commit hash.
4. Commit code **and** doc updates together, so every commit is
   self-consistent.

No task is "done" until docs are synced. An agent that finishes coding and
skips the sync has not finished the task.

## 2. Interrupt hygiene

If a session is interrupted mid-task: the next agent must assume the
uncommitted diff is the interrupted task (see the recovery procedure in
`MEMORY.md`). Never silently discard uncommitted work.

## 3. Build discipline

- `go build ./...`, `go vet ./...`, and `gofmt -l .` must be clean before
  every commit.
- Small commits, one concern each, imperative subject lines
  (`add openai provider`, not `misc changes`).

## 4. Scope and safety

- Never commit secrets. User API keys live in `~/.khode/auth.json`
  (0600) or env vars — never in the repo, and never in `config.json`
  (that file must stay shareable).
- Don't touch `.crush/` (user's local Crush state) or anything outside
  this repo.
- Don't upgrade dependencies casually; when forced to (build breakage),
  record it in `MEMORY.md` → Gotchas.
- Don't refactor across phases: e.g., don't add tool machinery before
  Phase 3 starts. Follow the `ROADMAP.md` order unless the user says
  otherwise.
- Deleting files or rewriting history requires explicit user approval.

## 5. Architecture invariants

- SDKs stay inside `internal/llm/<provider>.go`; core code sees only
  `llm.Message/Request/Event/Provider`.
- `agent.Session` is the single source of truth for LLM history; the UI
  list is display-only.
- Streaming events always terminate with `DoneEvent` or `ErrorEvent`
  before the channel closes.
- All state changes go through `Update`; `View` stays pure.

## 6. When unsure

Ask the user rather than guessing on: product behavior changes, new
dependencies, permission-model design, anything irreversible.
