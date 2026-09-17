package agent

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"

	"khode/internal/llm"
)

func userMsg(content string) llm.Message { return llm.Message{Role: llm.RoleUser, Content: content} }
func asstMsg(content string) llm.Message {
	return llm.Message{Role: llm.RoleAssistant, Content: content}
}
func toolResMsg(id string) llm.Message {
	return llm.Message{Role: llm.RoleTool, ToolResult: &llm.ToolResult{CallID: id, Content: "out"}}
}

func TestCutIndex(t *testing.T) {
	msgs := []llm.Message{
		userMsg("first request"),
		asstMsg("working"),
		toolResMsg("c1"),
		userMsg("second request"),
		asstMsg("done"),
	}

	// A generous budget keeps the newest clean user boundary (index 3).
	if got := cutIndex(msgs, 10_000); got != 3 {
		t.Errorf("cutIndex = %d, want 3", got)
	}
	// A budget too small for even the tail keeps everything: the only
	// clean boundaries are 0 and 3, and 0 means "nothing to compact".
	if got := cutIndex(msgs, 1); got != 0 {
		t.Errorf("cutIndex = %d, want 0 (tail cannot fit)", got)
	}
	// Tool results never start the tail: [user, asst, tool] has its only
	// clean boundary at 0, which means "nothing to compact".
	paired := []llm.Message{userMsg("go"), asstMsg("calling"), toolResMsg("c1")}
	if got := cutIndex(paired, 1); got != 0 {
		t.Errorf("cutIndex = %d, want 0 (no compactable boundary)", got)
	}
	// A budget that fits nothing at all also means no compaction.
	if got := cutIndex(paired, 0); got != 0 {
		t.Errorf("cutIndex = %d, want 0", got)
	}
}

func TestEstimateTokensGrowsWithContent(t *testing.T) {
	small := estimateTokens("sys", []llm.Message{userMsg("hi")})
	big := estimateTokens("sys", []llm.Message{userMsg(strings.Repeat("x", 4000))})
	if small <= 0 || big <= small {
		t.Errorf("estimate not monotonic: small=%d big=%d", small, big)
	}
}

// TestRunnerCompactsNearWindow drives a full turn whose usage crosses the
// trigger: between rounds the loop must summarize, rewrite the session,
// and continue on the compacted history. Old bulk messages sit before the
// cut; the current turn's tail fits the keep budget untouched.
func TestRunnerCompactsNearWindow(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		// Round 1: huge usage, then a tool call.
		{
			llm.UsageEvent{InputTokens: 200_000, OutputTokens: 10},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo", Input: json.RawMessage(`{"q":"hi"}`)}},
		},
		// The summarization request: a short prose summary.
		{llm.TextDeltaEvent{Text: "The user asked about things; a tool was called."}},
		// Round 2: the model finishes after compaction.
		{llm.TextDeltaEvent{Text: "all done"}},
	}}
	tl := &fakeTool{}
	r, sess := newTestRunner(t, p, tl)

	// Bulk history from earlier turns (~50k estimated tokens each): big
	// enough that the keep budget cannot swallow it, small enough to stay
	// far under the summarizer's own window.
	bulk := strings.Repeat("context ", 25_000)
	if err := sess.Append(userMsg(bulk)); err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(asstMsg(bulk)); err != nil {
		t.Fatal(err)
	}

	evs := drain(t, r.Run(t.Context(), "kick off"))
	if _, ok := evs[len(evs)-1].(llm.DoneEvent); !ok {
		t.Fatalf("last event = %T, want DoneEvent", evs[len(evs)-1])
	}

	// A CompactEvent reported the rewrite.
	var compacted bool
	for _, ev := range evs {
		if c, ok := ev.(llm.CompactEvent); ok {
			compacted = true
			if c.Removed != 2 || c.Kept != 3 {
				t.Errorf("CompactEvent = (%d removed, %d kept), want (2, 3)", c.Removed, c.Kept)
			}
		}
	}
	if !compacted {
		t.Error("no CompactEvent emitted")
	}

	// Session truth: summary + kept tail, never orphaned tool results.
	msgs := sess.Messages()
	if len(msgs) != 4 {
		t.Fatalf("session has %d messages, want 4: %+v", len(msgs), msgs)
	}
	if msgs[0].Role != llm.RoleUser || !strings.Contains(msgs[0].Content, "Summary of earlier conversation") {
		t.Errorf("msgs[0] = %+v, want user turn carrying the summary", msgs[0])
	}
	if !strings.Contains(msgs[0].Content, "The user asked about things") {
		t.Errorf("summary text missing from msgs[0]: %q", msgs[0].Content)
	}
	if !strings.Contains(msgs[0].Content, "kick off") {
		t.Errorf("kept user content lost after merge: %q", msgs[0].Content)
	}
	if msgs[1].Role != llm.RoleAssistant || len(msgs[1].ToolCalls) != 1 {
		t.Errorf("msgs[1] = %+v, want assistant call", msgs[1])
	}
	if msgs[2].Role != llm.RoleTool || msgs[2].ToolResult == nil {
		t.Errorf("msgs[2] = %+v, want paired tool result", msgs[2])
	}

	// The round-2 request must have gone out with the compacted history
	// and the summarizer must not have advertised tools.
	if len(p.requests) != 3 {
		t.Fatalf("provider called %d times, want 3 (round, summary, round)", len(p.requests))
	}
	summary := p.requests[1]
	if len(summary.Tools) != 0 {
		t.Errorf("summarization request advertised %d tools", len(summary.Tools))
	}
	if summary.System != summarizeSystem {
		t.Errorf("summarization system = %q", summary.System)
	}
	final := p.requests[2]
	if len(final.Messages) == 0 || !strings.Contains(final.Messages[0].Content, "Summary of earlier conversation") {
		t.Errorf("final request history not compacted: %+v", final.Messages)
	}
	// Tool definitions stay advertised for the real work.
	if len(final.Tools) != 1 || final.Tools[0].Name != "echo" {
		t.Errorf("final request tools = %+v, want echo", final.Tools)
	}
}

// TestRunnerNoCompactWhenSmall: a short conversation never triggers a
// summarization request.
func TestRunnerNoCompactWhenSmall(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.UsageEvent{InputTokens: 100}, llm.TextDeltaEvent{Text: "hi"}},
	}}
	r, sess := newTestRunner(t, p, nil)
	drain(t, r.Run(t.Context(), "hello"))

	if len(p.requests) != 1 {
		t.Errorf("provider called %d times, want 1 (no summarizer round)", len(p.requests))
	}
	if msgs := sess.Messages(); len(msgs) != 2 {
		t.Errorf("session has %d messages, want untouched 2", len(msgs))
	}
}

// TestRunnerCompactFailureContinues: when the summarizer errors, the turn
// proceeds on the uncompressed history instead of dying.
func TestRunnerCompactFailureContinues(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		// Round 1 crosses the trigger and requests a tool.
		{
			llm.UsageEvent{InputTokens: 200_000},
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "echo", Input: json.RawMessage(`{}`)}},
		},
		// The summarizer blows up.
		{llm.ErrorEvent{Err: errFake{}}},
		// Round 2 still happens, on the uncompressed history.
		{llm.TextDeltaEvent{Text: "second"}},
	}}
	tl := &fakeTool{}
	r, sess := newTestRunner(t, p, tl)
	// Bulk history gives the cut somewhere to land; without it there is
	// nothing to compact and the summarizer is never called.
	bulk := strings.Repeat("context ", 25_000)
	if err := sess.Append(userMsg(bulk)); err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(asstMsg(bulk)); err != nil {
		t.Fatal(err)
	}
	evs := drain(t, r.Run(t.Context(), "go"))
	if _, ok := evs[len(evs)-1].(llm.DoneEvent); !ok {
		t.Fatalf("last event = %T, want DoneEvent despite compact failure", evs[len(evs)-1])
	}
	// Session untouched by the failed compaction: bulk user, bulk
	// assistant, user, assistant call, tool result, final assistant turn.
	msgs := sess.Messages()
	if len(msgs) != 6 {
		t.Fatalf("session has %d messages, want 6: %+v", len(msgs), msgs)
	}
	if msgs[2].Content != "go" || msgs[5].Content != "second" {
		t.Errorf("history mutated by failed compaction: %+v", msgs)
	}
	// The round-2 request still carried the full uncompressed history.
	if len(p.requests) != 3 || len(p.requests[2].Messages) != 5 {
		t.Errorf("unexpected request pattern: %d calls", len(p.requests))
	}
}

// errFake is a distinct error type for the compact-failure test.
type errFake struct{}

func (errFake) Error() string { return "summary exploded" }

// TestSessionReplacePersists: a compacted transcript reloads intact from
// disk and leaves no temp file behind.
func TestSessionReplacePersists(t *testing.T) {
	sess, err := NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range []llm.Message{userMsg("one"), asstMsg("two"), userMsg("three")} {
		if err := sess.Append(m); err != nil {
			t.Fatal(err)
		}
	}
	replacement := []llm.Message{userMsg("compacted head"), asstMsg("kept tail")}
	if err := sess.Replace(replacement); err != nil {
		t.Fatalf("Replace: %v", err)
	}

	reloaded, err := Open(sess.Path)
	if err != nil {
		t.Fatalf("Open after Replace: %v", err)
	}
	msgs := reloaded.Messages()
	if len(msgs) != 2 || msgs[0].Content != "compacted head" || msgs[1].Content != "kept tail" {
		t.Errorf("reloaded = %+v, want the replacement turns", msgs)
	}
	if _, err := os.Stat(sess.Path + ".tmp"); !errors.Is(err, os.ErrNotExist) {
		t.Error("Replace left a temp file behind")
	}
}

// TestRunnerForcedCompact: the /compact entry point rewrites the session
// even when usage is nowhere near the trigger.
func TestRunnerForcedCompact(t *testing.T) {
	p := &fakeProvider{responses: [][]llm.Event{
		{llm.TextDeltaEvent{Text: "brief summary"}},
	}}
	r, sess := newTestRunner(t, p, nil)
	for _, m := range []llm.Message{userMsg("first"), asstMsg("earlier answer"), userMsg("second")} {
		if err := sess.Append(m); err != nil {
			t.Fatal(err)
		}
	}

	n, err := r.Compact(t.Context())
	if err != nil {
		t.Fatalf("Compact: %v", err)
	}
	if n != 2 {
		t.Errorf("Compact removed %d messages, want 2", n)
	}
	msgs := sess.Messages()
	if len(msgs) != 1 {
		t.Fatalf("session has %d messages, want 1 merged turn", len(msgs))
	}
	head := msgs[0].Content
	if !strings.Contains(head, "brief summary") || !strings.Contains(head, "second") {
		t.Errorf("merged head lost summary or kept content: %q", head)
	}
	if !strings.HasPrefix(head, "## Summary of earlier conversation") {
		t.Errorf("merged head should lead with the summary: %q", head)
	}
}
