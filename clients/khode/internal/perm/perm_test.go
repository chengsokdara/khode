package perm

import "testing"

func TestDecide(t *testing.T) {
	cases := []struct {
		mode Mode
		risk Risk
		want Decision
	}{
		{ModePlan, RiskRead, DecisionAllow},
		{ModePlan, RiskWrite, DecisionDeny},
		{ModePlan, RiskExec, DecisionDeny},
		{ModeAsk, RiskRead, DecisionAllow},
		{ModeAsk, RiskWrite, DecisionAsk},
		{ModeAsk, RiskExec, DecisionAsk},
		{ModeAcceptEdits, RiskRead, DecisionAllow},
		{ModeAcceptEdits, RiskWrite, DecisionAllow},
		{ModeAcceptEdits, RiskExec, DecisionAsk},
		{ModeAuto, RiskRead, DecisionAllow},
		{ModeAuto, RiskWrite, DecisionAllow},
		{ModeAuto, RiskExec, DecisionAllow},
		// Unknown modes degrade to the safe default.
		{"yolo", RiskWrite, DecisionAsk},
		{"yolo", RiskRead, DecisionAllow},
	}
	for _, c := range cases {
		if got := Decide(c.mode, c.risk); got != c.want {
			t.Errorf("Decide(%q, %q) = %v, want %v", c.mode, c.risk, got, c.want)
		}
	}
}

func TestParse(t *testing.T) {
	if got := Parse(" Accept-Edits "); got != ModeAcceptEdits {
		t.Errorf("Parse with spaces/case = %q", got)
	}
	for _, bad := range []string{"", "yolo", "AUTOPILOT"} {
		if got := Parse(bad); got != DefaultMode {
			t.Errorf("Parse(%q) = %q, want default", bad, got)
		}
	}
}

func TestNext(t *testing.T) {
	// The full ladder wraps: cycling from any mode reaches every other.
	modes := Modes()
	for i, m := range modes {
		if got := Next(m); got != modes[(i+1)%len(modes)] {
			t.Errorf("Next(%q) = %q, want %q", m, got, modes[(i+1)%len(modes)])
		}
	}
	if got := Next("yolo"); got != DefaultMode {
		t.Errorf("Next(unknown) = %q, want default", got)
	}
}
