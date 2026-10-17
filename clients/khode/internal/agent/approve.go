package agent

import (
	"context"

	"khode/internal/llm"
	"khode/internal/perm"
)

// Approver consents to risky tool calls on the user's behalf. Approve
// blocks until an answer arrives; a cancelled ctx counts as declining.
// preview is the tool's description of what it would change (empty when
// the tool cannot preview).
type Approver interface {
	Approve(ctx context.Context, call llm.ToolCall, risk perm.Risk, preview string) bool
}

// RequestKind separates the two kinds of bridge questions.
type RequestKind int

const (
	// KindTool asks permission to run one tool call.
	KindTool RequestKind = iota
	// KindPlan asks the user to approve a whole plan (the plan tool).
	KindPlan
)

// Request is one question the agent side parks for the UI.
type Request struct {
	Kind RequestKind
	Call llm.ToolCall
	Risk perm.Risk
	// Preview carries what the dialog shows: the tool's change preview
	// for KindTool, the plan markdown for KindPlan.
	Preview string

	reply chan bool
}

// Answer records the user's decision. The reply channel is buffered, so
// answering a request whose asker is already gone never blocks.
func (r Request) Answer(allow bool) { r.reply <- allow }

// Bridge carries questions from the agent side to the UI and the
// answers back. It implements Approver; the loop calls Approve on its
// goroutine, the UI consumes Requests and calls Answer.
type Bridge struct {
	requests chan Request
}

// NewBridge returns a ready bridge. One bridge serves the whole app; at
// most one request is ever outstanding because questions are asked
// sequentially.
func NewBridge() *Bridge {
	return &Bridge{requests: make(chan Request, 1)}
}

// Requests exposes the stream of pending questions.
func (b *Bridge) Requests() <-chan Request { return b.requests }

// Approve implements Approver: publish the question and block for the
// answer or cancellation.
func (b *Bridge) Approve(ctx context.Context, call llm.ToolCall, risk perm.Risk, preview string) bool {
	return b.ask(ctx, Request{Kind: KindTool, Call: call, Risk: risk, Preview: preview})
}

// ApprovePlan publishes a whole-plan question (the plan tool) and
// blocks for the answer. When the UI answers true it also switches the
// app to accept-edits mode itself; the boolean only reports the choice.
func (b *Bridge) ApprovePlan(ctx context.Context, plan string) bool {
	return b.ask(ctx, Request{Kind: KindPlan, Preview: plan})
}

// ask publishes one question and blocks for its answer; a cancelled
// ctx counts as declining.
func (b *Bridge) ask(ctx context.Context, req Request) bool {
	req.reply = make(chan bool, 1)
	select {
	case b.requests <- req:
	case <-ctx.Done():
		return false
	}
	select {
	case allow := <-req.reply:
		return allow
	case <-ctx.Done():
		return false
	}
}
