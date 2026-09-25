package ui

import (
	"context"
	"strings"
	"testing"

	"khode/internal/config"
	"khode/internal/llm"

	tea "charm.land/bubbletea/v2"
)

// gatherProvider replays one scripted response per Stream call: the
// gatherer and the main turn each consume a fresh copy.
type gatherProvider struct {
	once []llm.Event
}

func (p *gatherProvider) Name() string { return "gather" }

func (p *gatherProvider) Stream(_ context.Context, _ llm.Request) (<-chan llm.Event, error) {
	ch := make(chan llm.Event, len(p.once)+1)
	for _, ev := range p.once {
		ch <- ev
	}
	close(ch)
	return ch, nil
}

// newGatherModel is a test model with a stored key (so submit's
// credential preflight passes) and a scripted provider.
func newGatherModel(t *testing.T, p *gatherProvider) Model {
	t.Helper()
	m := newTestModel(t)
	m.provider = p
	m.auth = &config.Auth{APIKeys: map[string]string{"test": "k"}}
	return m
}

// pumpUntilQuiet drives the real waitForEvents chain until streaming
// ends, exactly as the app consumes the gather phase and the turn.
func pumpUntilQuiet(t *testing.T, m Model) Model {
	t.Helper()
	for m.streaming {
		msg := waitForEvents(m.events, nil, nil)()
		if msg == nil {
			break
		}
		next, _ := m.Update(msg)
		m = next.(Model)
	}
	return m
}

func atSize(t *testing.T, m Model) Model {
	t.Helper()
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	return next.(Model)
}

func TestGatherPhaseInjectsBriefAndStartsTurn(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "## Summary\nthe repo is a Go TUI."},
		llm.DoneEvent{},
	}}
	m := atSize(t, newGatherModel(t, p))

	m.messages = append(m.messages, uiMessage{role: llm.RoleUser, raw: "fix the layout", history: true})
	if !m.shouldGather() {
		t.Fatal("fresh session should gather")
	}
	m = pumpUntilQuiet(t, startGatherModel(m, "fix the layout"))

	if m.gathering || m.streaming {
		t.Fatalf("phases did not settle: gathering=%v streaming=%v", m.gathering, m.streaming)
	}
	// The transcript: gatherer brief as <task-context>, then the user's
	// turn, then the answer.
	msgs := m.session.Messages()
	if len(msgs) != 3 {
		t.Fatalf("session has %d messages, want 3", len(msgs))
	}
	if !strings.HasPrefix(msgs[0].Content, "<task-context>") || msgs[1].Content != "fix the layout" {
		t.Fatalf("unexpected first two messages: %q / %q", msgs[0].Content, msgs[1].Content)
	}
	// The live view: the gather block became the dim context brief.
	var sawBrief bool
	for _, msg := range m.messages {
		if msg.kind == kindContext {
			sawBrief = true
		}
		if msg.kind == kindGather {
			t.Error("gather block survived the handoff")
		}
	}
	if !sawBrief {
		t.Error("no context-brief block after the gather")
	}
}

// startGatherModel appends the user block and opens the gather phase,
// the same sequence submit runs on a fresh session.
func startGatherModel(m Model, input string) Model {
	m.messages = append(m.messages, uiMessage{role: llm.RoleUser, raw: input, history: true})
	m.startGather(input)
	return m
}

func TestGatherDisabledSkipsPhase(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "answer"},
		llm.DoneEvent{},
	}}
	m := atSize(t, newGatherModel(t, p))
	m.cfg.SetGatherContext(false)

	if m.shouldGather() {
		t.Fatal("toggle-off session must not gather")
	}
	m = pumpUntilQuiet(t, func() Model {
		m.messages = append(m.messages, uiMessage{role: llm.RoleUser, raw: "hello", history: true})
		m.startTurn("hello")
		return m
	}())
	if m.gathering {
		t.Fatal("gather ran while disabled")
	}
	if len(m.session.Messages()) != 2 {
		t.Fatalf("disabled gather should run a plain turn: %d messages", len(m.session.Messages()))
	}
}

func TestGatherEscStopsWithoutTurn(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.ErrorEvent{Err: context.Canceled},
	}}
	m := atSize(t, newGatherModel(t, p))
	m = startGatherModel(m, "a task")
	if !m.gathering {
		t.Fatal("gather not running")
	}

	next, _ := m.Update(streamEventMsg{ev: llm.ErrorEvent{Err: context.Canceled}})
	m = next.(Model)

	if m.gathering || m.streaming {
		t.Fatalf("esc did not stop the submit: gathering=%v streaming=%v", m.gathering, m.streaming)
	}
	if len(m.session.Messages()) != 0 {
		t.Fatalf("esc wrote to the session: %+v", m.session.Messages())
	}
	for _, msg := range m.messages {
		if msg.kind == kindGather || msg.kind == kindContext {
			t.Fatalf("gather block survived esc")
		}
	}
}

func TestShouldGatherOnlyOnFreshSession(t *testing.T) {
	m := newTestModel(t)
	if !m.shouldGather() {
		t.Fatal("empty session should gather")
	}
	if err := m.session.Append(llm.Message{Role: llm.RoleUser, Content: "earlier"}); err != nil {
		t.Fatal(err)
	}
	if m.shouldGather() {
		t.Fatal("session with history must not gather")
	}
}
