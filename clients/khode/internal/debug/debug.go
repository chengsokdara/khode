// Package debug gates development logging behind khode's --debug flag.
// TUI code must never write to stderr unconditionally: output that lands
// mid-frame corrupts the alternate screen, so every log line goes
// through here and is a no-op unless --debug turned logging on.
package debug

import "log"

// on is flipped by Enable, which main calls for --debug runs.
var on bool

// Enable turns debug logging on; output goes wherever the standard
// logger does (main points it at a file via tea.LogToFile).
func Enable() { on = true }

// Enabled reports whether debug logging is on.
func Enabled() bool { return on }

// Printf logs one line when debugging is on; otherwise a no-op.
func Printf(format string, args ...any) {
	if on {
		log.Printf(format, args...)
	}
}
