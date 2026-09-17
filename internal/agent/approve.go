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

// Request is one permission question the agent loop parks for the UI.
type Request struct {
	Call    llm.ToolCall
	Risk    perm.Risk
	Preview string

	reply chan bool
}

// Answer records the user's decision. The reply channel is buffered, so
// answering a request whose asker is already gone never blocks.
func (r Request) Answer(allow bool) { r.reply <- allow }

// Bridge carries permission questions from the agent loop to the UI and
// the answers back. It implements Approver; the loop calls Approve on its
// goroutine, the UI consumes Requests and calls Answer.
type Bridge struct {
	requests chan Request
}

// NewBridge returns a ready bridge. One bridge serves the whole app; at
// most one request is ever outstanding because the loop asks questions
// sequentially.
func NewBridge() *Bridge {
	return &Bridge{requests: make(chan Request, 1)}
}

// Requests exposes the stream of pending questions.
func (b *Bridge) Requests() <-chan Request { return b.requests }

// Approve implements Approver: publish the question and block for the
// answer or cancellation.
func (b *Bridge) Approve(ctx context.Context, call llm.ToolCall, risk perm.Risk, preview string) bool {
	req := Request{Call: call, Risk: risk, Preview: preview, reply: make(chan bool, 1)}
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
