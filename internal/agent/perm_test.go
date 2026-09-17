package agent

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"khode/internal/llm"
	"khode/internal/perm"
)

// gatedTool is a fakeTool that declares a risk and can preview.
type gatedTool struct {
	fakeTool
	risk perm.Risk
}

func (t *gatedTool) Risk() perm.Risk { return t.risk }

func (t *gatedTool) Preview(args json.RawMessage) (string, error) {
	return "preview of " + t.Name(), nil
}

// stubApprover records questions and answers from a script.
type stubApprover struct {
	seen     []llm.ToolCall
	risks    []perm.Risk
	previews []string
	answers  []bool
}

func (a *stubApprover) Approve(ctx context.Context, call llm.ToolCall, risk perm.Risk, preview string) bool {
	a.seen = append(a.seen, call)
	a.risks = append(a.risks, risk)
	a.previews = append(a.previews, preview)
	if len(a.answers) == 0 {
		return false
	}
	ok := a.answers[0]
	a.answers = a.answers[1:]
	return ok
}

// callOnce scripts one provider response that invokes name.
func callOnce(name string) []llm.Event {
	return []llm.Event{llm.ToolCallEvent{ToolCall: llm.ToolCall{
		ID: "c1", Name: name, Input: json.RawMessage(`{}`),
	}}}
}

func TestRunnerAskApproveRunsTool(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "ok"}}}}
	tool := &gatedTool{risk: perm.RiskWrite}
	appr := &stubApprover{answers: []bool{true}}
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModeAsk
	r.Approver = appr

	drain(t, r.Run(t.Context(), "go"))

	if len(appr.seen) != 1 || appr.seen[0].Name != "echo" {
		t.Fatalf("approver saw %+v, want one echo call", appr.seen)
	}
	if appr.risks[0] != perm.RiskWrite {
		t.Errorf("approver risk = %q", appr.risks[0])
	}
	if appr.previews[0] != "preview of echo" {
		t.Errorf("approver preview = %q", appr.previews[0])
	}
	// Approved call really ran and its result fed the session.
	msgs := sess.Messages()
	if msgs[2].ToolResult == nil || msgs[2].ToolResult.IsError {
		t.Errorf("approved tool result = %+v, want success", msgs[2].ToolResult)
	}
}

func TestRunnerAskDeclineFeedsBack(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "fine"}}}}
	tool := &gatedTool{risk: perm.RiskWrite}
	appr := &stubApprover{answers: []bool{false}}
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModeAsk
	r.Approver = appr

	drain(t, r.Run(t.Context(), "go"))

	msgs := sess.Messages()
	res := msgs[2].ToolResult
	if res == nil || !res.IsError || !strings.Contains(res.Content, "declined") {
		t.Errorf("declined result = %+v, want declined error", res)
	}
	if len(tool.got) != 0 {
		t.Error("declined tool was executed anyway")
	}
}

func TestRunnerNilApproverDeclines(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "fine"}}}}
	tool := &gatedTool{risk: perm.RiskExec}
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModeAsk

	drain(t, r.Run(t.Context(), "go"))

	if res := sess.Messages()[2].ToolResult; res == nil || !strings.Contains(res.Content, "declined") {
		t.Errorf("nil-approver result = %+v, want declined", res)
	}
}

func TestRunnerPlanModeDeniesWithoutAsking(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "planning"}}}}
	tool := &gatedTool{risk: perm.RiskWrite}
	appr := &stubApprover{answers: []bool{true}} // would approve, but must not be asked
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModePlan
	r.Approver = appr

	drain(t, r.Run(t.Context(), "go"))

	if len(appr.seen) != 0 {
		t.Error("plan mode consulted the approver")
	}
	res := sess.Messages()[2].ToolResult
	if res == nil || !res.IsError || !strings.Contains(res.Content, "blocked in plan mode") {
		t.Errorf("plan-mode result = %+v", res)
	}
}

func TestRunnerAcceptEditsAutoApprovesWrites(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "ok"}}}}
	tool := &gatedTool{risk: perm.RiskWrite}
	appr := &stubApprover{}
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModeAcceptEdits
	r.Approver = appr

	drain(t, r.Run(t.Context(), "go"))

	if len(appr.seen) != 0 {
		t.Error("accept-edits asked for a file write")
	}
	if res := sess.Messages()[2].ToolResult; res == nil || res.IsError {
		t.Errorf("auto-approved result = %+v, want success", res)
	}
}

func TestRunnerReadToolsNeverAsk(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "ok"}}}}
	tool := &gatedTool{risk: perm.RiskRead}
	appr := &stubApprover{}
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModeAsk
	r.Approver = appr

	drain(t, r.Run(t.Context(), "go"))

	if len(appr.seen) != 0 {
		t.Error("read-only tool triggered an approval")
	}
	if res := sess.Messages()[2].ToolResult; res == nil || res.IsError {
		t.Errorf("read tool result = %+v, want success", res)
	}
}

// TestRunnerBridgeApproval exercises the full seam: the loop's gate, the
// bridge, and a real answering goroutine standing in for the UI.
func TestRunnerBridgeApproval(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "ok"}}}}
	tool := &gatedTool{risk: perm.RiskWrite}
	r, sess := newTestRunner(t, p, tool)
	r.Mode = perm.ModeAsk
	bridge := NewBridge()
	r.Approver = bridge

	// The "UI": answer the question with a rejection first; the tool
	// result must reflect that, not a panic or a hang.
	go func() {
		req := <-bridge.Requests()
		req.Answer(false)
	}()
	drain(t, r.Run(t.Context(), "go"))
	if res := sess.Messages()[2].ToolResult; res == nil || !strings.Contains(res.Content, "declined") {
		t.Fatalf("bridge-rejected result = %+v", res)
	}

	// Now approve: the call runs for real.
	p2 := &fakeProvider{responses: [][]llm.Event{callOnce("echo"), {llm.TextDeltaEvent{Text: "ok"}}}}
	r2, sess2 := newTestRunner(t, p2, tool)
	r2.Mode = perm.ModeAsk
	bridge2 := NewBridge()
	r2.Approver = bridge2
	go func() {
		req := <-bridge2.Requests()
		req.Answer(true)
	}()
	drain(t, r2.Run(t.Context(), "go"))
	if res := sess2.Messages()[2].ToolResult; res == nil || res.IsError {
		t.Errorf("bridge-approved result = %+v, want success", res)
	}
}

func TestBridgeRoundTrip(t *testing.T) {
	b := NewBridge()
	ctx := t.Context()

	go func() {
		req := <-b.Requests()
		if req.Call.Name != "edit" || req.Risk != perm.RiskWrite || req.Preview != "diff" {
			t.Errorf("request = %+v", req)
		}
		req.Answer(true)
	}()
	req := llm.ToolCall{ID: "1", Name: "edit"}
	if !b.Approve(ctx, req, perm.RiskWrite, "diff") {
		t.Error("Approve returned false for an answered-true request")
	}

	// A cancelled context declines without needing an answer.
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if b.Approve(cctx, req, perm.RiskWrite, "diff") {
		t.Error("Approve returned true for a cancelled context")
	}

	// The abandoned request can still be answered safely: the reply
	// channel is buffered, so a late user decision never blocks.
	b2 := NewBridge()
	ictx, icancel := context.WithCancel(ctx)
	var late Request
	done := make(chan struct{})
	go func() {
		late = <-b2.Requests()
		icancel()
		close(done)
	}()
	b2.Approve(ictx, req, perm.RiskWrite, "diff")
	<-done
	late.Answer(true) // nobody is waiting; must not block
}
