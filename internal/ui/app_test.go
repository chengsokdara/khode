package ui

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/tools"

	tea "github.com/charmbracelet/bubbletea"
)

// nameOnlyProvider satisfies Provider for tests that never stream.
type nameOnlyProvider struct{}

func (nameOnlyProvider) Name() string { return "test" }
func (nameOnlyProvider) Stream(_ context.Context, _ llm.Request) (<-chan llm.Event, error) {
	return nil, nil
}

// newTestModel builds a Model over a temp session with default tools.
func newTestModel(t *testing.T) Model {
	t.Helper()
	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(cfg, &config.Auth{}, nameOnlyProvider{}, sess,
		tools.Default(t.TempDir()), nil, t.TempDir())
}

// pumpModel feeds scripted events through the real Update loop the same
// way waitForEvents delivers them, until the turn finishes.
func pumpModel(t *testing.T, m Model, evs []llm.Event) Model {
	t.Helper()
	ch := make(chan llm.Event, len(evs)+1)
	for _, ev := range evs {
		ch <- ev
	}
	close(ch)

	m.events = ch
	m.streaming = true
	for m.streaming {
		msg := waitForEvents(ch, nil)()
		var cmd tea.Cmd
		var next tea.Model
		next, cmd = m.Update(msg)
		m = next.(Model)
		// Only the waitForEvents chain matters here; spinner and cursor
		// commands carry nothing to deliver in a test.
		_ = cmd
	}
	return m
}

func TestToolBlocksRender(t *testing.T) {
	evs := []llm.Event{
		llm.TextDeltaEvent{Text: "checking the readme"},
		llm.ToolCallEvent{ToolCall: llm.ToolCall{
			ID: "c1", Name: "read", Input: json.RawMessage(`{"path":"README.md"}`),
		}},
		llm.ToolResultEvent{CallID: "c1", Name: "read", Output: "line one\nline two\nline three"},
		llm.TextDeltaEvent{Text: "here is what I found"},
	}
	m := pumpModel(t, newTestModel(t), evs)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})

	var sawCall, sawResult, sawFinal bool
	for i, msg := range m.messages {
		out := m.block(i, 80)
		switch msg.kind {
		case kindToolCall:
			if !strings.Contains(out, "⏺ read") || !strings.Contains(out, `"path":"README.md"`) {
				t.Errorf("tool call block = %q", out)
			}
			sawCall = true
		case kindToolResult:
			if !strings.Contains(out, "line one") || !strings.Contains(out, "+1 more lines") {
				t.Errorf("tool result block = %q", out)
			}
			sawResult = true
		default:
			if msg.role == llm.RoleAssistant && strings.Contains(out, "here is what I found") {
				sawFinal = true
			}
		}
	}
	if !sawCall || !sawResult || !sawFinal {
		t.Fatalf("blocks missing: call=%v result=%v final=%v", sawCall, sawResult, sawFinal)
	}
	if m.streaming {
		t.Error("model still streaming after Done")
	}
}

func TestErrorResultBlock(t *testing.T) {
	evs := []llm.Event{
		llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "read", Input: json.RawMessage(`{}`)}},
		llm.ToolResultEvent{CallID: "c1", Name: "read", Output: "no such file", IsError: true},
		llm.DoneEvent{},
	}
	m := pumpModel(t, newTestModel(t), evs)

	found := false
	for i, msg := range m.messages {
		if msg.kind == kindToolResult && msg.isErr {
			found = true
			if out := m.block(i, 80); !strings.Contains(out, "no such file") {
				t.Errorf("error block = %q", out)
			}
		}
	}
	if !found {
		t.Error("error result block missing")
	}
}

func TestCompactEventNotice(t *testing.T) {
	evs := []llm.Event{
		llm.TextDeltaEvent{Text: "working on it"},
		llm.CompactEvent{Removed: 12, Kept: 4},
		llm.TextDeltaEvent{Text: "done"},
	}
	m := pumpModel(t, newTestModel(t), evs)

	found := false
	for _, msg := range m.messages {
		if msg.role == "system" && strings.Contains(msg.raw, "summarized 12 earlier messages") {
			found = true
		}
	}
	if !found {
		t.Error("compaction notice missing from the transcript")
	}
}

func TestTodoResultShowsWholeList(t *testing.T) {
	evs := []llm.Event{
		llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "todo", Input: json.RawMessage(`{}`)}},
		llm.ToolResultEvent{CallID: "c1", Name: "todo",
			Output: "❯ one\n☐ two\n☐ three\n☐ four\n☑ five"},
		llm.DoneEvent{},
	}
	m := pumpModel(t, newTestModel(t), evs)

	found := false
	for i, msg := range m.messages {
		if msg.kind == kindToolResult && msg.full {
			found = true
			out := m.block(i, 80)
			for _, want := range []string{"❯ one", "☑ five"} {
				if !strings.Contains(out, want) {
					t.Errorf("todo block %q missing %q — list must render whole", out, want)
				}
			}
		}
	}
	if !found {
		t.Error("todo result was not flagged full")
	}
}

// Thinking streams into its own styled block ahead of the answer: the
// ✻ marker marks it, and the answer never mixes with the reasoning.
func TestThinkingBlockSeparatesFromAnswer(t *testing.T) {
	evs := []llm.Event{
		llm.ThinkingDeltaEvent{Text: "weighing options"},
		llm.TextDeltaEvent{Text: "final answer"},
	}
	m := pumpModel(t, newTestModel(t), evs)
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})

	var sawThink, sawAnswer bool
	for i, msg := range m.messages {
		out := m.block(i, 80)
		switch {
		case msg.kind == kindThinking:
			sawThink = true
			if !strings.Contains(out, "✻ weighing options") {
				t.Errorf("thinking block = %q, want marker + reasoning", out)
			}
		case msg.role == llm.RoleAssistant:
			sawAnswer = true
			if strings.Contains(out, "weighing options") {
				t.Errorf("answer block leaked thinking: %q", out)
			}
			if !strings.Contains(out, "final answer") {
				t.Errorf("answer block = %q", out)
			}
		}
	}
	if !sawThink || !sawAnswer {
		t.Fatalf("blocks missing: think=%v answer=%v", sawThink, sawAnswer)
	}
}

// A thinking-only turn (model thought, then stopped) still renders the
// reasoning block after the stream ends.
func TestThinkingOnlyTurnRenders(t *testing.T) {
	evs := []llm.Event{
		llm.ThinkingDeltaEvent{Text: "just thinking"},
		llm.DoneEvent{},
	}
	m := pumpModel(t, newTestModel(t), evs)

	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	found := false
	for i, msg := range m.messages {
		if msg.kind == kindThinking {
			found = true
			if out := m.block(i, 80); !strings.Contains(out, "✻ just thinking") {
				t.Errorf("thinking block = %q", out)
			}
		}
	}
	if !found {
		t.Error("thinking-only turn rendered no thinking block")
	}
}

// khateway is keyless-native: with no key anywhere, a submitted turn
// starts instead of being stopped by the pre-flight key check.
func TestKhatewayTurnStartsWithoutKey(t *testing.T) {
	m := newTestModel(t)
	t.Setenv("KHATEWAY_API_KEY", "")
	m.cfg.Provider = "khateway"
	m.cfg.SetModel("gateway-model") // model pre-flight must pass too

	m.textarea.SetValue("hello")
	cmd := m.submit()

	for _, msg := range m.messages {
		if msg.role == "system" && strings.Contains(msg.raw, "no API key") {
			t.Fatalf("keyless khateway turn was blocked: %q", msg.raw)
		}
	}
	last := m.messages[len(m.messages)-1]
	if last.role != llm.RoleUser || last.raw != "hello" {
		t.Errorf("last message = %+v, want the user turn", last)
	}
	if !m.streaming || cmd == nil {
		t.Error("turn did not start")
	}
	// cmd is deliberately not run: the test provider's channel is nil.
}

// Providers that do need a key keep the pre-flight: a keyless turn is
// stopped with a pointer to /settings instead of a doomed request.
func TestKeylessTurnStillBlockedForOtherProviders(t *testing.T) {
	m := newTestModel(t) // provider "test", no key anywhere
	m.textarea.SetValue("hello")
	m.submit()

	blocked := false
	for _, msg := range m.messages {
		if msg.role == "system" && strings.Contains(msg.raw, "no API key") {
			blocked = true
		}
	}
	if !blocked {
		t.Error("keyless turn was not stopped by the pre-flight")
	}
	if m.streaming {
		t.Error("turn started without a key")
	}
}
