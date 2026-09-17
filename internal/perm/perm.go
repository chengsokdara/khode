// Package perm decides which tool risk classes may run under khode's
// permission modes. It is pure policy: the agent loop applies the
// decision and the UI supplies the human answer when asked.
package perm

import "strings"

// Mode is a permission mode: how much the agent may do unprompted.
type Mode string

const (
	// ModePlan denies every mutating tool; the agent may only inspect.
	ModePlan Mode = "plan"
	// ModeAsk asks before every mutating tool call.
	ModeAsk Mode = "ask"
	// ModeAcceptEdits auto-approves file changes but still asks before
	// running shell commands.
	ModeAcceptEdits Mode = "accept-edits"
	// ModeAuto approves everything.
	ModeAuto Mode = "auto"
)

// DefaultMode applies when the config names no mode (or an unknown one).
const DefaultMode = ModeAsk

// Modes lists the valid mode names in switch order.
func Modes() []Mode { return []Mode{ModePlan, ModeAsk, ModeAcceptEdits, ModeAuto} }

// Parse normalizes s into a Mode, mapping unknown values to DefaultMode.
func Parse(s string) Mode {
	m := Mode(strings.ToLower(strings.TrimSpace(s)))
	for _, known := range Modes() {
		if m == known {
			return m
		}
	}
	return DefaultMode
}

// Risk is how much a tool can affect the world. Tools that do not
// declare a risk are read-only.
type Risk string

const (
	RiskRead  Risk = "read"  // inspect files only
	RiskWrite Risk = "write" // create or modify files
	RiskExec  Risk = "exec"  // run shell commands
)

// Decision is what a mode says about one risk class.
type Decision int

const (
	DecisionAllow Decision = iota
	DecisionAsk
	DecisionDeny
)

// Decide maps mode × risk to a decision. Unrecognized modes degrade to
// the safe default (ask).
func Decide(m Mode, r Risk) Decision {
	switch m {
	case ModeAuto:
		return DecisionAllow
	case ModeAcceptEdits:
		if r == RiskExec {
			return DecisionAsk
		}
		return DecisionAllow
	case ModePlan:
		if r == RiskRead {
			return DecisionAllow
		}
		return DecisionDeny
	default:
		if r == RiskRead {
			return DecisionAllow
		}
		return DecisionAsk
	}
}
