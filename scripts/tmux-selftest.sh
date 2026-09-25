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
# The fake server (fakeai.py) replays a fixed scenario per prompt:
# round 1 thinking + prose + a 27-line write call, round 2 an edit
# call, round 3 a closing answer. Every new prompt replays it again.
set -euo pipefail
cd "$(dirname "$0")/.."

DIR=${TMPDIR:-/tmp}/khode-selftest
mkdir -p "$DIR/home/.khode" "$DIR/work"
go build -o "$DIR/khode" ./cmd/khode

cat > "$DIR/home/.khode/config.json" << 'JSON'
{
  "provider": "fakeai",
  "permission_mode": "auto",
  "max_tokens": 1024,
  "models": { "fakeai": "test-model" },
  "custom_providers": { "fakeai": { "kind": "openai", "base_url": "http://127.0.0.1:19731/v1" } }
}
JSON

# A fresh server per run: the scenario's round counter is process state.
pkill -f "fakeai.py" 2>/dev/null || true
sleep 0.3
python3 scripts/fakeai.py > "$DIR/fakeai.log" 2>&1 &
sleep 0.5

tmux -L khv kill-server 2>/dev/null || true
tmux -L khv new-session -d -x 100 -y 32 -s main -c "$DIR/work" \
  "env HOME=$DIR/home FAKEAI_API_KEY=x $DIR/khode 2>>$DIR/khode.stderr"
sleep 2

tmux -L khv send-keys -t main "write then edit" Enter
sleep 3.5

echo "=== plain capture (what the user reads) ==="
tmux -L khv capture-pane -p -t main
echo
echo "=== SGR capture of the diff rows (what the terminal paints) ==="
tmux -L khv capture-pane -e -p -t main | grep -E "EDITED|48;5" | cat -v | head -6
echo
echo "session left running: tmux -L khv attach -t main · cleanup: tmux -L khv kill-server"
