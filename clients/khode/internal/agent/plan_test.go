package agent

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"khode/internal/perm"
)

// planRunner builds a Runner whose registry contains only the plan tool,
// plus the bridge its questions ride.
func planRunner(t *testing.T, mode perm.Mode) (*Runner, *Bridge) {
	t.Helper()
	r, _ := newTestRunner(t, &fakeProvider{}, nil)
	bridge := NewBridge()
	modeFn := func() perm.Mode { return mode }
	r.Tools.Register(NewPlanTool(bridge, modeFn))
	return r, bridge
}

func TestPlanToolApprovalFlow(t *testing.T) {
	r, bridge := planRunner(t, perm.ModePlan)

	// The UI side: take the question and approve it.
	approved := make(chan bool, 1)
	go func() {
		req := <-bridge.Requests()
		if req.Kind != KindPlan {
			t.Errorf("request kind = %v, want KindPlan", req.Kind)
		}
		if !strings.Contains(req.Preview, "step one") {
			t.Errorf("preview missing the plan: %q", req.Preview)
		}
		approved <- true
		req.Answer(true)
	}()

	tt, _ := r.Tools.Get("plan")
	out, err := tt.Exec(context.Background(), json.RawMessage(`{"plan":"# plan\nstep one"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "accept-edits") {
		t.Fatalf("approval result = %q", out)
	}
	if !strings.Contains(out, "todo") {
		t.Errorf("approval result does not hand the plan off to the todo list: %q", out)
	}
	if !<-approved {
		t.Fatal("approval did not round-trip")
	}
}

func TestPlanToolDeclinedFlow(t *testing.T) {
	r, bridge := planRunner(t, perm.ModePlan)

	go func() {
		req := <-bridge.Requests()
		req.Answer(false)
	}()

	tt, _ := r.Tools.Get("plan")
	_, err := tt.Exec(context.Background(), json.RawMessage(`{"plan":"hasty plan"}`))
	if err == nil || !strings.Contains(err.Error(), "declined") {
		t.Fatalf("decline err = %v", err)
	}
}

func TestPlanToolCancelledWhileWaiting(t *testing.T) {
	r, _ := planRunner(t, perm.ModePlan)

	ctx, cancel := context.WithCancel(context.Background())
	cancel() // the user interrupted while the dialog was open

	tt, _ := r.Tools.Get("plan")
	_, err := tt.Exec(ctx, json.RawMessage(`{"plan":"never shown"}`))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled so the loop wording applies", err)
	}
}

func TestPlanToolRequiresPlanMode(t *testing.T) {
	for _, mode := range []perm.Mode{perm.ModeAsk, perm.ModeAcceptEdits, perm.ModeAuto} {
		r, _ := planRunner(t, mode)
		tt, _ := r.Tools.Get("plan")
		if _, err := tt.Exec(context.Background(), json.RawMessage(`{"plan":"x"}`)); err == nil ||
			!strings.Contains(err.Error(), "plan mode") {
			t.Fatalf("mode %s: err = %v", mode, err)
		}
	}
}

func TestPlanToolValidatesInput(t *testing.T) {
	r, _ := planRunner(t, perm.ModePlan)
	tt, _ := r.Tools.Get("plan")

	if _, err := tt.Exec(context.Background(), json.RawMessage(`{}`)); err == nil {
		t.Fatal("empty plan accepted")
	}
	if _, err := tt.Exec(context.Background(), json.RawMessage(`not json`)); err == nil {
		t.Fatal("malformed args accepted")
	}
}

func TestPlanToolIsCallableInPlanMode(t *testing.T) {
	r, _ := planRunner(t, perm.ModePlan)
	if risk := r.Tools.RiskOf("plan"); risk != perm.RiskRead {
		t.Fatalf("plan risk = %v, want read so plan mode allows it", risk)
	}
	if perm.Decide(perm.ModePlan, perm.RiskRead) != perm.DecisionAllow {
		t.Fatal("plan mode must allow read-risk tools")
	}
}
