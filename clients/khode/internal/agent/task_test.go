package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/llm"
	"khode/internal/perm"
)

// taskRunner builds a Runner whose registry contains only the task tool,
// configured with the given subagent mode.
func taskRunner(t *testing.T, p llm.Provider, mode perm.Mode) (*Runner, *Session) {
	t.Helper()
	r, sess := newTestRunner(t, p, nil)
	tt := NewTaskTool(SubagentConfig{
		Provider:  p,
		Workdir:   t.TempDir(),
		Model:     func() string { return "test-model" },
		MaxTokens: func() int { return 100 },
		Mode:      func() perm.Mode { return mode },
		Approver:  nil,
	})
	r.Tools.Register(tt)
	return r, sess
}

func callTask(t *testing.T, r *Runner, prompt string) (llm.ToolResult, []llm.Event) {
	t.Helper()
	evs := drain(t, r.Run(context.Background(), "go"))
	for _, ev := range evs {
		if res, ok := ev.(llm.ToolResultEvent); ok && res.Name == "task" {
			return llm.ToolResult{CallID: res.CallID, Content: res.Output, IsError: res.IsError}, evs
		}
	}
	t.Fatalf("no task result among %d events", len(evs))
	return llm.ToolResult{}, nil
}

func TestTaskToolRunsSubagent(t *testing.T) {
	// Outer turn 1 asks for a task; subagent turn 1 uses the real glob
	// tool against an empty workdir; subagent turn 2 reports; outer
	// turn 2 finishes with the report quoted back.
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"count go files"}`)}},
		},
		{ // subagent round 1: a real tool call through tools.Default
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "s1", Name: "glob",
				Input: json.RawMessage(`{"pattern":"**/*.go"}`)}},
		},
		{ // subagent round 2: the report
			llm.TextDeltaEvent{Text: "I found no go files."},
		},
		{
			llm.TextDeltaEvent{Text: "report says: I found no go files."},
		},
	}}
	r, sess := taskRunner(t, p, perm.ModeAsk)

	res, _ := callTask(t, r, "count go files")
	if res.IsError {
		t.Fatalf("task failed: %s", res.Content)
	}
	if res.Content != "I found no go files." {
		t.Fatalf("report = %q", res.Content)
	}

	// The main transcript shows the task result, never the subagent's
	// internals (its glob call must not leak into the parent history).
	var got []string
	for _, m := range sess.Messages() {
		got = append(got, string(m.Role))
	}
	want := []string{string(llm.RoleUser), string(llm.RoleAssistant), string(llm.RoleTool), string(llm.RoleAssistant)}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("main transcript roles = %v, want %v", got, want)
	}
}

func TestTaskToolSubagentFailureIsErrorResult(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"doomed"}`)}},
		},
		{ // subagent stream dies with a real error
			llm.ErrorEvent{Err: errors.New("provider exploded")},
		},
	}}
	r, _ := taskRunner(t, p, perm.ModeAsk)

	res, _ := callTask(t, r, "doomed")
	if !res.IsError || !strings.Contains(res.Content, "provider exploded") {
		t.Fatalf("want error result carrying the cause, got isErr=%v %q", res.IsError, res.Content)
	}
}

func TestTaskToolPlanModeKeepsSubagentReadOnly(t *testing.T) {
	// In plan mode the subagent's write is denied (error result inside
	// the subagent), the subagent then reports, and nothing was written.
	target := filepath.Join(t.TempDir(), "should-not-exist.txt")
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"try to write"}`)}},
		},
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "s1", Name: "write",
				Input: json.RawMessage(`{"path":"` + target + `","content":"nope"}`)}},
		},
		{
			llm.TextDeltaEvent{Text: "write was blocked by plan mode."},
		},
		{
			llm.TextDeltaEvent{Text: "blocked."},
		},
	}}
	r, _ := taskRunner(t, p, perm.ModePlan)

	res, _ := callTask(t, r, "try to write")
	if res.IsError || res.Content != "write was blocked by plan mode." {
		t.Fatalf("res = %+v", res)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("subagent wrote a file in plan mode")
	}
}

func TestTaskToolValidatesPrompt(t *testing.T) {
	r, _ := taskRunner(t, &fakeProvider{}, perm.ModeAsk)
	tt, _ := r.Tools.Get("task")

	if _, err := tt.Exec(context.Background(), json.RawMessage(`{}`)); err == nil {
		t.Fatal("empty prompt accepted")
	}
	if _, err := tt.Exec(context.Background(), json.RawMessage(`not json`)); err == nil {
		t.Fatal("malformed args accepted")
	}
}

func TestTaskToolClipsReport(t *testing.T) {
	big := strings.Repeat("x", maxTaskResult+10)
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"big"}`)}},
		},
		{
			llm.TextDeltaEvent{Text: big},
		},
		{
			llm.TextDeltaEvent{Text: "done"},
		},
	}}
	r, _ := taskRunner(t, p, perm.ModeAsk)

	res, _ := callTask(t, r, "big")
	if res.IsError {
		t.Fatalf("task failed: %s", res.Content)
	}
	if len(res.Content) > maxTaskResult || !strings.HasSuffix(res.Content, "(…truncated)") {
		t.Fatalf("report not clipped: %d chars, suffix %q", len(res.Content), res.Content[max(0, len(res.Content)-30):])
	}
}

func TestMemorySessionStaysOffDisk(t *testing.T) {
	s := NewMemorySession()
	if err := s.Append(llm.Message{Role: llm.RoleUser, Content: "hi"}); err != nil {
		t.Fatal(err)
	}
	if s.Name() != "memory" {
		t.Fatalf("name = %q", s.Name())
	}
	if err := s.Replace(s.Messages()[:0]); err != nil {
		t.Fatal(err)
	}
	if len(s.Messages()) != 0 {
		t.Fatal("replace did not clear memory session")
	}
}
