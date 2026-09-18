package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"khode/internal/llm"
	"khode/internal/tools"
)

// fakeProvider replays scripted event lists, one per Stream call, and
// records every request it receives.
type fakeProvider struct {
	responses [][]llm.Event
	requests  []llm.Request
}

func (f *fakeProvider) Name() string { return "fake" }

func (f *fakeProvider) Stream(ctx context.Context, req llm.Request) (<-chan llm.Event, error) {
	f.requests = append(f.requests, req)
	if len(f.responses) == 0 {
		return nil, fmt.Errorf("no scripted response for call %d", len(f.requests))
	}
	resp := f.responses[0]
	f.responses = f.responses[1:]

	ch := make(chan llm.Event, len(resp)+1)
	for _, ev := range resp {
		ch <- ev
	}
	ch <- llm.DoneEvent{}
	close(ch)
	return ch, nil
}

// fakeTool records its arguments and returns a canned answer.
type fakeTool struct {
	got []json.RawMessage
}

func (t *fakeTool) Name() string        { return "echo" }
func (t *fakeTool) Description() string { return "echo its input" }
func (t *fakeTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`)
}
func (t *fakeTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var m map[string]any
	if err := json.Unmarshal(args, &m); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	t.got = append(t.got, args)
	return fmt.Sprintf("echoed %d args", len(t.got)), nil
}

// drain collects events from a Run channel, applying the termination
// contract: exactly one terminal event, then close.
func drain(t *testing.T, ch <-chan llm.Event) []llm.Event {
	t.Helper()
	var evs []llm.Event
	for ev := range ch {
		evs = append(evs, ev)
	}
	if len(evs) == 0 {
		t.Fatal("Run closed with no events")
	}
	switch evs[len(evs)-1].(type) {
	case llm.DoneEvent, llm.ErrorEvent:
	default:
		t.Fatalf("last event %T is not terminal", evs[len(evs)-1])
	}
	return evs
}

func newTestRunner(t *testing.T, p llm.Provider, tl tools.Tool) (*Runner, *Session) {
	t.Helper()
	sess, err := NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reg := tools.NewRegistry()
	if tl != nil {
		reg.Register(tl)
	}
	return &Runner{
		Provider: p, Session: sess, Tools: reg,
		Model: "test-model", MaxTokens: 100,
		System: "test system",
	}, sess
}

func TestRunnerToolLoop(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.TextDeltaEvent{Text: "let me check"},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo", Input: json.RawMessage(`{"q":"hi"}`)}},
		},
		{
			llm.TextDeltaEvent{Text: "all done"},
		},
	}}
	tl := &fakeTool{}
	r, sess := newTestRunner(t, p, tl)

	evs := drain(t, r.Run(t.Context(), "what up"))

	// Event order: round-1 text + tool call, the result, round-2 text, usage-free Done.
	wantKinds := []string{"text", "toolcall", "toolresult", "text", "done"}
	if len(evs) != len(wantKinds) {
		t.Fatalf("got %d events, want %d: %T", len(evs), len(wantKinds), evs)
	}
	for i, kind := range wantKinds {
		var got string
		switch evs[i].(type) {
		case llm.TextDeltaEvent:
			got = "text"
		case llm.ToolCallEvent:
			got = "toolcall"
		case llm.ToolResultEvent:
			got = "toolresult"
		case llm.DoneEvent:
			got = "done"
		}
		if got != kind {
			t.Errorf("events[%d] = %s (%T), want %s", i, got, evs[i], kind)
		}
	}
	res := evs[2].(llm.ToolResultEvent)
	if res.IsError || res.Output != "echoed 1 args" {
		t.Errorf("tool result = %+v, want success with echoed output", res)
	}

	// Session truth: user, assistant(text+call), tool(result), assistant(final).
	msgs := sess.Messages()
	if len(msgs) != 4 {
		t.Fatalf("session has %d messages, want 4", len(msgs))
	}
	if msgs[0].Role != llm.RoleUser || msgs[0].Content != "what up" {
		t.Errorf("msgs[0] = %+v, want user turn", msgs[0])
	}
	if msgs[1].Role != llm.RoleAssistant || msgs[1].Content != "let me check" || len(msgs[1].ToolCalls) != 1 {
		t.Errorf("msgs[1] = %+v, want assistant turn with one call", msgs[1])
	}
	if msgs[2].Role != llm.RoleTool || msgs[2].ToolResult == nil || msgs[2].ToolResult.CallID != "c1" {
		t.Errorf("msgs[2] = %+v, want tool result for c1", msgs[2])
	}
	if msgs[3].Role != llm.RoleAssistant || msgs[3].Content != "all done" {
		t.Errorf("msgs[3] = %+v, want final assistant turn", msgs[3])
	}

	// The second request must contain the tool result so the model sees it.
	if len(p.requests) != 2 {
		t.Fatalf("provider called %d times, want 2", len(p.requests))
	}
	second := p.requests[1].Messages
	if len(second) != 3 || second[2].Role != llm.RoleTool {
		t.Fatalf("second request tail = %+v, want tool result turn", second)
	}
	if second[2].ToolResult.Content != "echoed 1 args" {
		t.Errorf("fed-back result = %q", second[2].ToolResult.Content)
	}
	if len(p.requests[1].Tools) != 1 || p.requests[1].Tools[0].Name != "echo" {
		t.Errorf("tools not advertised on second request: %+v", p.requests[1].Tools)
	}
}

func TestRunnerUnknownToolIsErrorResult(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "nope", Input: json.RawMessage(`{}`)}}},
		{llm.TextDeltaEvent{Text: "sorry"}},
	}}
	r, sess := newTestRunner(t, p, nil)

	evs := drain(t, r.Run(t.Context(), "go"))
	for _, ev := range evs {
		if res, ok := ev.(llm.ToolResultEvent); ok {
			if !res.IsError {
				t.Error("unknown tool did not produce an error result")
			}
			if !strings.Contains(res.Output, "unknown tool") {
				t.Errorf("error output = %q", res.Output)
			}
		}
	}
	// The error result is in the transcript, so the model can recover.
	if msgs := sess.Messages(); len(msgs) != 4 {
		t.Fatalf("session has %d messages, want 4", len(msgs))
	}
}

func TestRunnerDisabledToolIsErrorResult(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo", Input: json.RawMessage(`{}`)}}},
		{llm.TextDeltaEvent{Text: "ok"}},
	}}
	tl := &fakeTool{}
	r, _ := newTestRunner(t, p, tl)
	r.Tools.SetEnabled("echo", false)

	evs := drain(t, r.Run(t.Context(), "go"))
	for _, ev := range evs {
		if res, ok := ev.(llm.ToolResultEvent); ok {
			if !res.IsError {
				t.Error("disabled tool call did not produce an error result")
			}
			if !strings.Contains(res.Output, "disabled") {
				t.Errorf("error output = %q", res.Output)
			}
		}
	}
	// The disabled tool is never advertised to the provider either.
	if got := p.requests[0].Tools; len(got) != 0 {
		t.Errorf("disabled tool advertised: %+v", got)
	}
}

func TestRunnerToolErrorFeedsBack(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo", Input: json.RawMessage(`bad`)}}},
		{llm.TextDeltaEvent{Text: "recovered"}},
	}}
	tl := &fakeTool{}
	r, _ := newTestRunner(t, p, tl)

	evs := drain(t, r.Run(t.Context(), "go"))
	sawErr := false
	for _, ev := range evs {
		if res, ok := ev.(llm.ToolResultEvent); ok && res.IsError {
			sawErr = true
			if !strings.Contains(res.Output, "invalid arguments") {
				t.Errorf("arg error not surfaced: %q", res.Output)
			}
		}
	}
	if !sawErr {
		t.Error("tool execution error lost")
	}
}

func TestRunnerRoundCap(t *testing.T) {
	// The model always wants a tool → the cap must stop the loop.
	resp := []llm.Event{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c", Name: "echo"}}}
	p := &fakeProvider{}
	for i := 0; i < 10; i++ {
		p.responses = append(p.responses, resp)
	}
	tl := &fakeTool{}
	r, _ := newTestRunner(t, p, tl)
	r.MaxRounds = 3

	evs := drain(t, r.Run(t.Context(), "go"))
	last := evs[len(evs)-1]
	errEv, ok := last.(llm.ErrorEvent)
	if !ok {
		t.Fatalf("last event = %T, want ErrorEvent", last)
	}
	if !strings.Contains(errEv.Err.Error(), "3 rounds") {
		t.Errorf("cap error = %v", errEv.Err)
	}
	if len(p.requests) != 3 {
		t.Errorf("provider called %d times, want 3", len(p.requests))
	}
}

func TestRunnerStreamError(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.TextDeltaEvent{Text: "partial"}, llm.ErrorEvent{Err: context.DeadlineExceeded}},
	}}
	r, sess := newTestRunner(t, p, nil)

	evs := drain(t, r.Run(t.Context(), "go"))
	if _, ok := evs[len(evs)-1].(llm.ErrorEvent); !ok {
		t.Fatalf("last event = %T, want ErrorEvent", evs[len(evs)-1])
	}
	// The failed assistant turn is not persisted: the session stays at the
	// user turn, so the next request is well-formed.
	if msgs := sess.Messages(); len(msgs) != 1 {
		t.Errorf("session has %d messages, want 1 (user only)", len(msgs))
	}
}

func TestRunnerCancelDuringTool(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo"}}},
	}}
	tool := &blockingTool{started: make(chan struct{})}
	r, sess := newTestRunner(t, p, tool)

	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		<-tool.started
		cancel()
	}()
	evs := drain(t, r.Run(ctx, "go"))

	// Loop ends with the cancel error, and the transcript stays paired:
	// the tool call has an (interrupted) result.
	if _, ok := evs[len(evs)-1].(llm.ErrorEvent); !ok {
		t.Fatalf("last event = %T, want ErrorEvent", evs[len(evs)-1])
	}
	msgs := sess.Messages()
	if len(msgs) != 3 {
		t.Fatalf("session has %d messages, want user+assistant+tool, got %+v", len(msgs), msgs)
	}
	if msgs[2].ToolResult == nil || msgs[2].ToolResult.Content != "interrupted by user" {
		t.Errorf("interrupted result = %+v", msgs[2].ToolResult)
	}
}

// blockingTool signals on Exec and then waits for ctx cancellation.
type blockingTool struct {
	started chan struct{}
}

func (b *blockingTool) Name() string        { return "echo" }
func (b *blockingTool) Description() string { return "blocks" }
func (b *blockingTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object"}`)
}
func (b *blockingTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	close(b.started)
	<-ctx.Done()
	return "", ctx.Err()
}

// Thinking deltas are forwarded to the UI and stored on the assistant
// message for display, while the answer text stays in Content.
func TestRunnerThinkingPersists(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ThinkingDeltaEvent{Text: "think "},
			llm.ThinkingDeltaEvent{Text: "hard"},
			llm.TextDeltaEvent{Text: "the answer"},
		},
	}}
	r, sess := newTestRunner(t, p, nil)

	evs := drain(t, r.Run(t.Context(), "question"))
	sawThink := false
	for _, ev := range evs {
		if th, ok := ev.(llm.ThinkingDeltaEvent); ok {
			sawThink = true
			if th.Text == "" {
				t.Error("empty ThinkingDeltaEvent forwarded")
			}
		}
	}
	if !sawThink {
		t.Error("thinking deltas were not forwarded")
	}

	msgs := sess.Messages()
	if len(msgs) != 2 {
		t.Fatalf("session has %d messages, want 2", len(msgs))
	}
	a := msgs[1]
	if a.Role != llm.RoleAssistant {
		t.Fatalf("msgs[1].Role = %q, want assistant", a.Role)
	}
	if a.Content != "the answer" {
		t.Errorf("Content = %q, want the answer", a.Content)
	}
	if a.Thinking != "think hard" {
		t.Errorf("Thinking = %q, want %q", a.Thinking, "think hard")
	}

	// The provider request replays content only — no thinking echo.
	if got := p.requests[0].Messages[0].Content; got != "question" {
		t.Errorf("request content = %q, want question", got)
	}
}
