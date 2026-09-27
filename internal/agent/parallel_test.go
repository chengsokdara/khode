package agent

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"khode/internal/llm"
	"khode/internal/perm"
	"khode/internal/tools"
)

// sleepTool is a read-only tool that takes delay to run, for timing
// parallel execution. It logs start/stop marks into a shared, mutex
// guarded order slice.
type sleepTool struct {
	name  string
	delay time.Duration
	mu    *sync.Mutex
	order *[]string
}

func (s *sleepTool) Name() string        { return s.name }
func (s *sleepTool) Description() string { return "sleeps, then answers" }
func (s *sleepTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`)
}
func (s *sleepTool) Risk() perm.Risk { return perm.RiskRead }
func (s *sleepTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	s.mu.Lock()
	*s.order = append(*s.order, "start:"+s.name)
	s.mu.Unlock()
	select {
	case <-time.After(s.delay):
	case <-ctx.Done():
		return "", ctx.Err()
	}
	s.mu.Lock()
	*s.order = append(*s.order, "stop:"+s.name)
	s.mu.Unlock()
	return "done " + s.name, nil
}

// parallelRunner builds a Runner over the given sleep tools.
func parallelRunner(t *testing.T, p llm.Provider, ts ...tools.Tool) (*Runner, *Session) {
	t.Helper()
	r, sess := newTestRunner(t, p, nil)
	for _, tool := range ts {
		r.Tools.Register(tool)
	}
	return r, sess
}

func TestLoopRunsReadOnlyCallsInParallel(t *testing.T) {
	// Three read-only calls in one round, each taking 250ms: parallel
	// execution finishes in roughly one delay, nowhere near the serial
	// sum. Generous margins keep the assertion stable on slow machines.
	order := &[]string{}
	mu := &sync.Mutex{}
	var a, b, c tools.Tool = &sleepTool{name: "a", delay: 250 * time.Millisecond, mu: mu, order: order},
		&sleepTool{name: "b", delay: 250 * time.Millisecond, mu: mu, order: order},
		&sleepTool{name: "c", delay: 250 * time.Millisecond, mu: mu, order: order}
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "1", Name: "a", Input: json.RawMessage(`{}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "2", Name: "b", Input: json.RawMessage(`{}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "3", Name: "c", Input: json.RawMessage(`{}`)}},
			llm.DoneEvent{}},
		{llm.TextDeltaEvent{Text: "all read."}, llm.DoneEvent{}},
	}}
	r, sess := parallelRunner(t, p, a, b, c)

	start := time.Now()
	evs := drain(t, r.Run(context.Background(), "read all"))
	took := time.Since(start)
	if took > 600*time.Millisecond {
		t.Fatalf("round took %v — read-only calls did not run in parallel", took)
	}

	// Results still stream in call order, one per call.
	var got []string
	for _, ev := range evs {
		if res, ok := ev.(llm.ToolResultEvent); ok {
			got = append(got, res.CallID)
		}
	}
	if strings.Join(got, ",") != "1,2,3" {
		t.Fatalf("result order = %v, want the call order", got)
	}
	// The transcript pairs every call with a result, in call order.
	var results []string
	for _, m := range sess.Messages() {
		if m.Role == llm.RoleTool {
			results = append(results, m.ToolResult.CallID)
		}
	}
	if strings.Join(results, ",") != "1,2,3" {
		t.Fatalf("transcript results = %v, want 1,2,3", results)
	}
}

func TestLoopKeepsRiskyCallsSequential(t *testing.T) {
	// A round of [read, exec, read]: the read-only pair runs in
	// parallel, but both exec calls (write-risk here, same gate) stay
	// strictly ordered between and around groups.
	order := &[]string{}
	mu := &sync.Mutex{}
	read := &sleepTool{name: "r", delay: 120 * time.Millisecond, mu: mu, order: order}
	write := &exclusiveTool{name: "w", mu: mu, order: order}
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "1", Name: "r", Input: json.RawMessage(`{}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "2", Name: "w", Input: json.RawMessage(`{}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "3", Name: "w", Input: json.RawMessage(`{}`)}},
			llm.DoneEvent{}},
		{llm.TextDeltaEvent{Text: "ok."}, llm.DoneEvent{}},
	}}
	r, _ := parallelRunner(t, p, read, write)
	drain(t, r.Run(context.Background(), "mix"))

	mu.Lock()
	defer mu.Unlock()
	got := strings.Join(*order, " ")
	// The two risky calls must not interleave: each start precedes its
	// own stop and the two stops are adjacent.
	if !strings.Contains(got, "start:w stop:w start:w stop:w") {
		t.Fatalf("risky calls interleaved: %q", got)
	}
}

// exclusiveTool is a read-risk tool that vetoes parallel execution, the
// way a mutating task child does.
type exclusiveTool struct {
	name  string
	mu    *sync.Mutex
	order *[]string
}

func (e *exclusiveTool) Name() string        { return e.name }
func (e *exclusiveTool) Description() string { return "read-risk but exclusive" }
func (e *exclusiveTool) Schema() json.RawMessage {
	return json.RawMessage(`{"type":"object"}`)
}
func (e *exclusiveTool) Risk() perm.Risk { return perm.RiskRead }
func (e *exclusiveTool) Exclusive(args json.RawMessage) bool {
	return true
}
func (e *exclusiveTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	e.mu.Lock()
	*e.order = append(*e.order, "start:"+e.name)
	e.mu.Unlock()
	e.mu.Lock()
	*e.order = append(*e.order, "stop:"+e.name)
	e.mu.Unlock()
	return "done", nil
}

func TestTaskExclusiveByKind(t *testing.T) {
	// Only all-read children may fan out; anything that could mutate
	// (and unknown kinds, which normalize to general-purpose) vetoes.
	tt := NewTaskTool(SubagentConfig{Workdir: t.TempDir()})
	cases := []struct {
		input string
		want  bool
	}{
		{`{"prompt":"x","subagent_type":"explore"}`, false},
		{`{"prompt":"x","subagent_type":"context-gatherer"}`, false},
		{`{"prompt":"x","subagent_type":"plan"}`, false},
		{`{"prompt":"x","subagent_type":"code-reviewer"}`, false},
		{`{"prompt":"x","subagent_type":"general-purpose"}`, true},
		{`{"prompt":"x"}`, true},
		{`{"prompt":"x","subagent_type":"no-such-kind"}`, true},
	}
	for _, c := range cases {
		if got := tt.Exclusive(json.RawMessage(c.input)); got != c.want {
			t.Errorf("Exclusive(%s) = %v, want %v", c.input, got, c.want)
		}
	}
}

func TestTaskFanOutRunsChildrenConcurrently(t *testing.T) {
	// Two explore children spawned by one round run side by side: the
	// round finishes in roughly one child's duration, not the sum, and
	// both reports land in the parent transcript in call order.
	report := func(id string) []llm.Event {
		return []llm.Event{llm.TextDeltaEvent{Text: "report from " + id}, llm.DoneEvent{}}
	}
	p := &fakeProvider{responses: [][]llm.Event{
		{ // parent round 1: two explore spawns
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"one","subagent_type":"explore","description":"first"}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o2", Name: "task",
				Input: json.RawMessage(`{"prompt":"two","subagent_type":"explore","description":"second"}`)}},
			llm.DoneEvent{},
		},
		report("a"),
		report("b"),
		{llm.TextDeltaEvent{Text: "both reports in."}, llm.DoneEvent{}},
	}}
	r, sess := taskRunner(t, p, perm.ModeAsk)
	start := time.Now()
	var taskResults []string
	for ev := range r.Run(context.Background(), "fan out") {
		if res, ok := ev.(llm.ToolResultEvent); ok && res.Name == "task" {
			taskResults = append(taskResults, res.Output)
		}
	}
	took := time.Since(start)
	if took > 900*time.Millisecond {
		t.Fatalf("fan-out took %v — children did not run concurrently", took)
	}

	// Both children reported; their reports reached the parent. (Which
	// child consumed which scripted report is nondeterministic under
	// concurrency; the result events still emit in call order.)
	joined := strings.Join(taskResults, "|")
	if strings.Count(joined, "report from") != 2 {
		t.Fatalf("task results = %q", joined)
	}
	// The transcript carries exactly two task results, ordered.
	var order []string
	for _, m := range sess.Messages() {
		if m.Role == llm.RoleTool {
			order = append(order, m.ToolResult.CallID)
		}
	}
	if strings.Join(order, ",") != "o1,o2" {
		t.Fatalf("transcript results = %v", order)
	}
}

func TestParallelGroupCarriesCallIDInContext(t *testing.T) {
	// Progress lines from a fan-out carry the parent call's id, so the
	// UI can route them when children run side by side. Both children
	// get the same one-tool-call-then-report shape (responses are
	// consumed in nondeterministic order across the two children, so
	// per-round scripts must be identical for both).
	glob := func(pattern string) []llm.Event {
		return []llm.Event{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c", Name: "glob",
			Input: json.RawMessage(`{"pattern":"` + pattern + `"}`)}}, llm.DoneEvent{}}
	}
	report := func(text string) []llm.Event {
		return []llm.Event{llm.TextDeltaEvent{Text: text}, llm.DoneEvent{}}
	}
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"one","subagent_type":"explore"}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o2", Name: "task",
				Input: json.RawMessage(`{"prompt":"two","subagent_type":"explore"}`)}},
			llm.DoneEvent{},
		},
		glob("go"), glob("md"),
		report("report one."), report("report two."),
		{llm.TextDeltaEvent{Text: "done."}, llm.DoneEvent{}},
	}}
	var mu sync.Mutex
	var seen []string
	r, _ := newTestRunner(t, p, nil)
	tt := NewTaskTool(SubagentConfig{
		Provider:  p,
		Workdir:   t.TempDir(),
		Model:     func() string { return "m" },
		MaxTokens: func() int { return 100 },
		Progress: func(sp SubagentProgress) {
			mu.Lock()
			seen = append(seen, sp.CallID)
			mu.Unlock()
		},
	})
	r.Tools.Register(tt)
	drain(t, r.Run(context.Background(), "go"))

	mu.Lock()
	defer mu.Unlock()
	if len(seen) != 2 || !(seen[0] == "o1" && seen[1] == "o2" || seen[0] == "o2" && seen[1] == "o1") {
		t.Fatalf("progress call ids = %v, want one per parent call", seen)
	}
	for _, id := range seen {
		if id == "" {
			t.Fatal("progress line missing the parent call id")
		}
	}
}

func TestCanceledParallelGroupStillAnswersEveryCall(t *testing.T) {
	// A canceled context must not strand a tool call: every parallel
	// slot still appends its (interrupted) result.
	slow := &sleepTool{name: "s", delay: 5 * time.Second, mu: &sync.Mutex{}, order: &[]string{}}
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "1", Name: "s", Input: json.RawMessage(`{}`)}},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "2", Name: "s", Input: json.RawMessage(`{}`)}},
			llm.DoneEvent{}},
		{llm.TextDeltaEvent{Text: "never."}, llm.DoneEvent{}},
	}}
	r, sess := parallelRunner(t, p, slow)

	ctx, cancel := context.WithCancel(context.Background())
	time.AfterFunc(100*time.Millisecond, cancel)
	for ev := range r.Run(ctx, "go") {
		if _, ok := ev.(llm.ErrorEvent); ok {
			break // the turn-level error after cancellation
		}
	}
	results := 0
	for _, m := range sess.Messages() {
		if m.Role == llm.RoleTool {
			results++
			if m.ToolResult.Content != "interrupted by user" {
				t.Fatalf("canceled result = %q", m.ToolResult.Content)
			}
		}
	}
	if results != 2 {
		t.Fatalf("got %d results, want one per interrupted call", results)
	}
}
