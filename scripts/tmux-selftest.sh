#!/bin/bash
# tmux-selftest.sh — run khode against a scripted fake model in a real
# terminal (tmux, isolated socket) and capture the rendered frames, so
# TUI features are verified in a live TTY instead of asking the user
# for screenshots.
#
#   scripts/tmux-selftest.sh              # drive the scripted turn, print captures
#   tmux -L khv attach -t main            # poke at the session yourself
#   tmux -L khv kill-server               # clean up when done
#
# The fake server (fakeai.py) routes by request body: the first prompt
# replays thinking + prose + a 27-line write call, an edit call, and a
# closing answer; "now survey the repo" fires one task(explore) call;
# "fan out two explore searches now" fires TWO task(explore) calls in
# one round (parallel read-only fan-out). Children grep, then report
# after a ~3s hold so the live activity lines are readable in captures.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=${TMPDIR:-/tmp}/khode-selftest
mkdir -p "$DIR/home/.khode" "$DIR/work"
go build -o "$DIR/khode" ./cmd/khode
go build -o "$DIR/mcpserver" ./internal/mcp/testdata/mcpserver

# Unquoted so $DIR expands. The selftest MCP server runs in mutate mode:
# its first tools/call flips the advertised set and pushes
# notifications/tools/list_changed, which drives the refresh scenario.
cat > "$DIR/home/.khode/config.json" << JSON
{
  "provider": "fakeai",
  "permission_mode": "auto",
  "max_tokens": 1024,
  "models": { "fakeai": "test-model" },
  "custom_providers": { "fakeai": { "kind": "openai", "base_url": "http://127.0.0.1:19731/v1" } },
  "mcp_servers": { "selftest": { "command": "$DIR/mcpserver", "risk": "read", "env": ["KHOKE_MCP_MUTATE=1"] } }
}
JSON

# A fresh server per run: the scenario's round counter is process state.
pkill -f "fakeai.py" 2>/dev/null || true
sleep 0.3
python3 scripts/fakeai.py > "$DIR/fakeai.log" 2>&1 &
sleep 0.5

tmux -L khv kill-server 2>/dev/null || true
tmux -L khv new-session -d -x 100 -y 60 -s main -c "$DIR/work" \
  "env HOME=$DIR/home FAKEAI_API_KEY=x $DIR/khode 2>>$DIR/khode.stderr"
sleep 2

# First prompt of a fresh session: the context gatherer runs first
# (held ~1.5s so the block is readable), then the scripted write turn.
tmux -L khv send-keys -t main "write then edit" Enter
sleep 1.0
echo "=== mid-gather capture (gathering-context block expected) ==="
tmux -L khv capture-pane -p -t main | grep -E "gathering context" || true
sleep 2.0
echo "=== after-gather capture (context-brief block expected) ==="
tmux -L khv capture-pane -p -t main | grep -E "context brief|Summary:" || true
sleep 5.0

echo "=== plain capture (what the user reads) ==="
tmux -L khv capture-pane -p -t main
echo
echo "=== SGR capture of the diff rows (what the terminal paints) ==="
tmux -L khv capture-pane -e -p -t main | grep -E "EDITED|48;5" | cat -v | head -6
echo

# wait_ready polls the frame until the status line is back to ready, so
# the next scenario's prompt can never land mid-stream (enter is
# swallowed while a turn runs).
wait_ready() {
  for _ in $(seq 1 60); do
    if tmux -L khv capture-pane -p -t main | grep -q "● ready"; then
      return 0
    fi
    sleep 0.5
  done
  echo "timeout waiting for ready" >&2
}

# Task scenario: round 4 calls task(explore); the subagent's live
# activity line is held ~3s by the fake server, so a mid-flight capture
# catches it before the report block replaces it.
wait_ready
tmux -L khv send-keys -t main "now survey the repo" Enter
sleep 1.7
echo "=== mid-flight subagent capture (live activity line expected) ==="
tmux -L khv capture-pane -p -t main | grep -E "task|⎿" || true
wait_ready
echo
echo "=== final capture after the task report lands ==="
tmux -L khv capture-pane -p -t main | tail -14
echo

# Fan-out scenario: the fan-out prompt fires a round with TWO
# task(explore) calls; khode runs them side by side, so both call
# blocks carry their own live activity line at the same time (children
# are held ~3s by the fake server).
wait_ready
tmux -L khv send-keys -t main "fan out two explore searches now" Enter
sleep 2.0
echo "=== mid-flight fan-out capture (two live subagent lines expected) ==="
tmux -L khv capture-pane -p -t main | grep -E "task|⎿" || true
wait_ready
echo
echo "=== final capture after both fan-out reports land ==="
tmux -L khv capture-pane -p -t main | tail -16
echo

# MCP refresh scenario: the fake model calls the selftest server's echo
# tool; the server flips its tool set as it answers and pushes
# notifications/tools/list_changed, so khode re-lists live and reports
# the diff in chat — no restart involved. The follow-up prompt forces a
# turn (and with it an armed pump) so a notice that landed while idle is
# drained into scrollback either way; the fake server just answers it.
wait_ready
tmux -L khv send-keys -t main "call the mcp echo tool now (# MCP refresh)" Enter
sleep 1.0 # let the turn start, so wait_ready brackets it instead of no-oping
wait_ready
tmux -L khv send-keys -t main "and in five words, wrap up (# MCP refresh)" Enter
sleep 1.0
wait_ready
echo "=== mcp refresh capture (tools-refreshed notice expected) ==="
tmux -L khv capture-pane -p -t main | grep -E "tools refreshed|mcp:" || echo "NO MCP REFRESH NOTICE FOUND"
echo
echo "=== final capture after the mcp refresh ==="
tmux -L khv capture-pane -p -t main | tail -14
echo
echo "session left running: tmux -L khv attach -t main · cleanup: tmux -L khv kill-server"
