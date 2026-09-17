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
	return New(cfg, nameOnlyProvider{}, sess, tools.Default(t.TempDir()), t.TempDir())
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
