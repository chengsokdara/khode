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
