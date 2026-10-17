package agent

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"khode/internal/config"
	"khode/internal/hooks"
	"khode/internal/llm"
	"khode/internal/perm"
)

func TestPreToolHookVetoReachesModelAsError(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo",
				Input: json.RawMessage(`{"q":"hi"}`)}},
		},
		{
			llm.TextDeltaEvent{Text: "understood, skipping"},
		},
	}}
	r, _ := newTestRunner(t, p, &fakeTool{})
	r.Mode = staticMode(perm.ModeAuto) // even auto mode cannot overrule a hook veto
	r.Hooks = hooks.New(config.Hooks{PreTool: []config.Hook{
		{Command: `echo "echo is banned" >&2; exit 2`},
	}}, t.TempDir())

	evs := drain(t, r.Run(context.Background(), "go"))
	var res llm.ToolResultEvent
	for _, ev := range evs {
		if e, ok := ev.(llm.ToolResultEvent); ok {
			res = e
		}
	}
	if !res.IsError || !strings.Contains(res.Output, "echo is banned") {
		t.Fatalf("hook veto result = %+v", res)
	}
}

func TestPostToolHookRunsAfterExecution(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo",
				Input: json.RawMessage(`{}`)}},
		},
		{
			llm.TextDeltaEvent{Text: "done"},
		},
	}}
	r, _ := newTestRunner(t, p, &fakeTool{})

	// The hook captures the payload; if it ran, its file exists and
	// carries the tool output.
	dir := t.TempDir()
	capture := dir + "/payload.json"
	r.Hooks = hooks.New(config.Hooks{PostTool: []config.Hook{
		{Command: "cat > " + capture},
	}}, dir)

	drain(t, r.Run(context.Background(), "go"))
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatalf("post hook did not run: %v", err)
	}
	if !strings.Contains(string(data), `"output":"echoed 1 args"`) {
		t.Fatalf("payload missing tool output: %s", data)
	}
}

func TestPostToolFeedbackRidesToolResult(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo",
				Input: json.RawMessage(`{}`)}},
		},
		{
			llm.TextDeltaEvent{Text: "noted"},
		},
	}}
	r, sess := newTestRunner(t, p, &fakeTool{})
	r.Hooks = hooks.New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo "remember to run gofmt"`},
	}}, t.TempDir())

	evs := drain(t, r.Run(context.Background(), "go"))
	var res llm.ToolResultEvent
	for _, ev := range evs {
		if e, ok := ev.(llm.ToolResultEvent); ok {
			res = e
		}
	}
	want := "echoed 1 args\n\n<hook-feedback>\nremember to run gofmt\n</hook-feedback>"
	if res.IsError || res.Output != want {
		t.Fatalf("result output = %q, want %q", res.Output, want)
	}
	if got := sess.Messages()[2].ToolResult.Content; got != want {
		t.Fatalf("session result = %q, want %q", got, want)
	}
	// The provider replay carries the tagged content too.
	if fed := p.requests[1].Messages[2].ToolResult.Content; fed != want {
		t.Fatalf("fed-back result = %q, want %q", fed, want)
	}
}

func TestPostToolFeedbackAfterErrorResult(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo", Input: json.RawMessage(`bad`)}}},
		{llm.TextDeltaEvent{Text: "recovered"}},
	}}
	r, sess := newTestRunner(t, p, &fakeTool{})
	r.Hooks = hooks.New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo "check the args" >&2; exit 2`},
	}}, t.TempDir())

	drain(t, r.Run(context.Background(), "go"))
	got := sess.Messages()[2].ToolResult
	if !got.IsError || !strings.Contains(got.Content, "invalid arguments") {
		t.Fatalf("result = %+v, want the tool's arg error", got)
	}
	if !strings.Contains(got.Content, "check the args") {
		t.Fatalf("hook feedback missing from the errored result: %q", got.Content)
	}
}

func TestPostToolFeedbackAbsentOnCancel(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo"}}},
	}}
	tool := &blockingTool{started: make(chan struct{})}
	r, sess := newTestRunner(t, p, tool)
	r.Hooks = hooks.New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo seen`},
	}}, t.TempDir())

	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		<-tool.started
		cancel()
	}()
	drain(t, r.Run(ctx, "go"))

	got := sess.Messages()[2].ToolResult
	if got.Content != "interrupted by user" {
		t.Fatalf("interrupted result = %+v", got)
	}
	if strings.Contains(got.Content, "hook-feedback") {
		t.Fatalf("canceled call grew hook feedback: %q", got.Content)
	}
}
