# WORKFLOW.md — How features get built and verified

The working loop for any agent (or human) coding in this repo.
`RULES.md` carries the hard rules; this file carries the *how* — above
all the self-verification loop that keeps the user out of the QA seat:
**TUI features are tested in a live TTY here, not by asking the user
for screenshots.**

## The loop

1. **Plan non-trivial work first** (`EnterPlanMode`) — approach,
   trade-offs, and a verification step for each deliverable. Trivial
   fixes go straight to step 2.
2. **Implement with unit tests.** Core logic gets table tests; rendering
   gets assertions on the actual styled output (see "Rendering tests"
   below).
3. **Self-verify in a live TTY.** Anything the user will see gets run
   through `scripts/tmux-selftest.sh` (below) and the captured frames
   read before it is called done — with the scripted fake model
   extended if the feature needs a new scenario.
4. **Full gate** (must be clean before any commit):
   ```sh
   go build ./... && go vet ./... && gofmt -l . ; go test ./...
   ```
5. **Sync docs and commit** — `STATUS.md` (Now + Changelog),
   `MEMORY.md` (decisions, gotchas, session log), `ROADMAP.md` when the
   plan shifts. Code and docs in one commit.

Never report a TUI change as done from unit tests alone: unit tests
pin exact bytes, the tmux harness proves what a terminal actually
paints. Both have caught bugs the other missed.

## TUI self-testing in a live TTY

```sh
scripts/tmux-selftest.sh
```

One command builds khode, starts the scripted fake model, launches
khode in a real terminal (tmux, **isolated socket** — it can never
touch the user's own tmux sessions) with a throwaway `HOME`, drives a
full agent turn, and prints the rendered frames:

- **plain capture** — what the user reads (conversation, diff blocks,
  status line).
- **SGR capture** — what the terminal paints, escapes included, for
  rows matching the interesting patterns.

The session is left running for further poking:

```sh
tmux -L khv attach -t main      # interact with khode yourself
tmux -L khv send-keys -t main "another prompt" Enter
tmux -L khv send-keys -t main C-o          # key presses work too (expand toggle)
tmux -L khv capture-pane -p -t main        # re-capture any time
tmux -L khv capture-pane -e -p -t main     # with escape sequences
tmux -L khv kill-server                    # cleanup when done
```

Everything is throwaway: the HOME, the workdir (tool calls execute in
it), and the socket all live under a temp dir or the isolated socket.
Never attach the user's tmux server, never write the real
`~/.khode`.

### The fake model (`scripts/fakeai.py`)

A dependency-free OpenAI-protocol SSE server on `127.0.0.1:19731` that
routes by request body: the first prompt replays thinking + prose + a
`write` call creating a 27-line file (diff exceeds the 20-line chat
cap), then an `edit` call, then a closing answer; "now survey the repo"
fires a `task(explore)` call; "fan out two explore searches now" fires
TWO `task(explore)` calls in one round (the parallel read-only
fan-out). Task children grep, then report after a ~3s hold so the live
subagent activity lines are readable in captured frames. The server is
threaded so concurrent children are served truly concurrently. Extend
it when a feature needs other shapes: more rounds, other tools, error
results, parallel tool calls, `<think>`-tag content, malformed tool
arguments (khode must reject them gracefully). It is plain stdlib
Python — `httptest`-style fixtures in Go would not exercise the real
binary end to end.

### Gotchas learned the hard way

- **tmux re-encodes colors.** `capture-pane -e` emits tmux's own SGRs:
  truecolor becomes 256-palette forms (`48;5;22m`), and a dark red can
  map to a gray entry. Use `-e` captures to verify *structure* (a band
  covers the row, the right text is styled) and unit tests to verify
  *exact hexes*.
- **The round counter is process state.** Reusing a running fake server
  across runs replays the wrong round; the script kills and restarts it
  per run.
- **A full-screen app exiting takes the socket's server down** if it is
  the only session ("no server running" right after khode quits) —
  relaunch rather than debug it.
- **Stream tool-call argument fragments so their concatenation is valid
  JSON.** khode rejects malformed assembled arguments with a recoverable
  error result — which is correct behavior and will show up in your
  capture.
- Headless pty capture (pyte) produced no output for bubbletea v2 and
  is not the evidence path; tmux is ground truth. The static
  alternative for dialogs and popups is the dump harness:
  `DUMP_DIR=/tmp/x go test ./internal/ui -run TestDumpViews`.

## Rendering tests

Chat-block renderers are unit-tested in `internal/ui` with two layers,
and both matter:

- **Text layer** — `ansiStrip(m.block(i, width))` and assert on visible
  content (`⎿  Edited main.go`, gutter numbers, hints).
- **SGR layer** — assert on the raw styled string: exact color
  sequences (`"\x1b[38;2;197;134;192m"`), and *counts* when styling
  must survive a whole row. A presence-only check once passed while the
  background band visibly covered only the four-character gutter —
  counting occurrences (or asserting no mid-row resets) is what would
  have caught it.

When a color bug is suspected, dump the raw SGR stream of one rendered
row (`t.Logf("%q", row)`) and read it token by token — every SGR reset
in the middle of a row is a suspect, because parts of a row (lipgloss
gutter, chroma tokens) each reset their own styling. Watch for the two
reset forms: lipgloss writes short `ESC[m`, chroma long `ESC[0m`.

Known test traps: `Model` is copied by value — reassign after
`Update` (`m = next.(Model)`), and drive a `WindowSizeMsg` before
asserting on views (uncaptured resizes leave `m.width` 0). Tests must
isolate HOME (`isolateHome(t)`) so nothing can write the real
`~/.khode`.

## Feature-specific recipes

- **Diff/write features** run through the harness's scripted write +
  edit rounds; verify collapsed cap, ctrl+o expand/collapse via
  `send-keys C-o`, band coverage per row, gutter numbering.
- **Streaming/thinking features** are covered by round 1's
  `reasoning_content` stream; add shapes (tag-split content, empty
  deltas) in `fakeai.py` when needed.
- **Permission dialogs** use the fake model too (auto mode bypasses
  them; switch the generated config to `ask` to exercise the approval
  flow), or the `DUMP_DIR` harness for static frames.
