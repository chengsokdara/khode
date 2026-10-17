# scripts

- `ui-battery.sh [width] [height]` — end-to-end UI battery: builds nothing;
  run `go build -o khode-test ./cmd/khode` first, then run the script. It
  boots khode in a tmux session of the given size (default 100×30) with a
  throwaway HOME, drives the real TUI through boot, mode cycling, the
  /mode picker, popup cycles, seals, overlay cycles, multiline input,
  wheel scrolling, and exit, and asserts on captured screens.
  Requires tmux; `brew install tmux`.
