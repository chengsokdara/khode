#!/bin/bash
W=${1:-100}; H=${2:-30}
S=kb
pass=0; fail=0
grab() { tmux capture-pane -t $S -p; }
ck() { local n; n=$(grab | grep -c "$2"); if [ "$n" -eq "$3" ] 2>/dev/null; then echo "  PASS: $1"; pass=$((pass+1)); else echo "  FAIL: $1 ('$2' count=$n want $3)"; fail=$((fail+1)); fi }
ckzero() { local n; n=$(grab | grep -c "$2"); if [ "$n" -eq 0 ]; then echo "  PASS: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (found $n)"; fail=$((fail+1)); fi }
send() { tmux send-keys -t $S "$@"; }
wheel() { send -l $'\x1b[<64;50;15M'; }   # SGR wheel up
wheeld() { send -l $'\x1b[<65;50;15M'; }  # SGR wheel down
w() { sleep "${1:-0.5}"; }
snug() { local last; last=$(grab | grep -v '^[[:space:]]*$' | tail -1); if echo "$last" | grep -Eq "enter send|quit$"; then echo "  PASS: $1"; pass=$((pass+1)); else echo "  FAIL: $1 (last: $last)"; fail=$((fail+1)); fi; }

tmux kill-session -t $S 2>/dev/null
rm -rf /tmp/khode-t; mkdir -p /tmp/khode-t
tmux new-session -d -x $W -y $H -s $S "HOME=/tmp/khode-t ./khode-test"
w 2
echo "== 1. BOOT =="
ck "welcome overlay shown" "welcome to khode" 1
send Escape; w 1.2
ck "chat ready" "Ask khode to do something" 1
snug "input floats snug under content"

echo "== 2. SHIFT+TAB MODE CYCLING =="
for mode in accept-edits auto plan; do
  send -l $'\x1b[Z'
  sleep 3
  got=$(grab | grep -oE "⏵⏵ [a-z-]+" | head -1)
  echo "    [debug] expected $mode, saw after 3s: '${got:-none}'"
  ck "cycle → $mode" "⏵⏵ $mode" 1
done
send -l $'\x1b[Z'; w 0.9
ckzero "wraps to ask (hint hides)" "⏵⏵"
snug "mode line snug through cycling"

echo "== 3. /MODE PICKER =="
send "/mode"; w 0.5; send Enter; w 0.6; send Enter; w 0.7
ck "picker open" "enter apply" 1
send Down; send Down; w 0.4
send Enter; w 1
ck "applied (mode → auto)" "mode → auto" 1
snug "input snug after picker"

echo "== 4. POPUP CYCLE (the original ghost bug) =="
send C-u; w 0.3; send "/he"; w 0.8
ck "popup open over history" "enter run" 1
send Escape; w 0.8; send C-u; w 0.6
ckzero "no ghost after esc" "enter run"
snug "input snug after popup esc"
send "/he"; w 0.6; send BSpace; w 0.7; send BSpace; w 0.7; send BSpace; w 0.7
ckzero "popup closes when input empties" "enter run"

echo "== 5. HELP SEAL (no duplication) =="
send C-u; w 0.3; send "/help"; w 0.4; send Enter; w 1
ck "help output present" "alias of /exit" 1
n=$(grab | grep -c "this command list")
if [ "$n" -le 2 ]; then echo "  PASS: no duplicated help ($n)"; pass=$((pass+1)); else echo "  FAIL: duplicated ($n)"; fail=$((fail+1)); fi
snug "input snug after seal"

echo "== 6. TOOLS OVERLAY CYCLE =="
send C-u; w 0.3; send "/tools"; w 0.5; send Enter; w 1
ck "tools overlay open" "0/9 off" 1
send Escape; w 1.1
ckzero "tools closed clean" "0/9 off"
snug "input snug after tools close"

echo "== 7. MULTILINE INPUT =="
send "line one"; send Enter; send "line two"; w 0.6
ck "textarea grew" "line two" 1
snug "input snug while multiline"
send C-u; w 0.3

echo "== 8. PGUP/PGDN SCROLL THE VIEWPORT =="
# Distinct single-line seals, enough to overflow the viewport at this
# size: identical blocks would make every scroll window look the same,
# and too few lines give the scroll clamp nothing to slide.
count=$((H/2+12))
for i in $(seq 1 $count); do send "/model test-$i"; w 0.25; send Enter; w 0.45; done
w 0.5
frame_before=$(grab | md5)
send PgUp; send PgUp; w 0.7
frame_after=$(grab | md5)
if [ "$frame_before" != "$frame_after" ]; then echo "  PASS: pgup scrolled back"; pass=$((pass+1)); else echo "  FAIL: pgup did nothing"; fail=$((fail+1)); fi
send PgDn; send PgDn; w 0.7
snug "pgdn returns to live edge"

echo "== 9. EXIT =="
send C-u; w 0.3; send "/exit"; w 0.4; send Enter; w 1.2
if pgrep -f khode-final >/dev/null; then echo "  FAIL: still running"; fail=$((fail+1)); else echo "  PASS: exited"; pass=$((pass+1)); fi

echo ""
echo "RESULT ($W x $H): $pass passed, $fail failed"
