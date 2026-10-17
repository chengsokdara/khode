package ui

import (
	"strings"
	"testing"

	"khode/internal/llm"

	tea "charm.land/bubbletea/v2"
)

// queueTurnModel is a credential-carrying model on a scripted provider
// with the auto-gatherer off, ready to start a turn on submit.
func queueTurnModel(t *testing.T, p *gatherProvider) Model {
	t.Helper()
	m := newGatherModel(t, p)
	m.cfg.SetGatherContext(false)
	return atSize(t, m)
}

// While a turn streams, plain enter files the prompt instead of racing
// the turn: the queue holds it, the input clears, and the band above the
// input shows the head of the line.
func TestEnterMidTurnQueuesPrompt(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "working on it."},
		llm.DoneEvent{},
	}}
	m := queueTurnModel(t, p)

	m.textarea.SetValue("first question")
	m.submit() // starts turn 1; its pump cmd is discarded, events unpumped
	if !m.streaming {
		t.Fatal("turn 1 did not start")
	}
	before := len(m.messages)

	m.textarea.SetValue("second question   ")
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if got := m.queued; len(got) != 1 || got[0] != "second question" {
		t.Fatalf("queue = %q, want [second question] (trimmed)", got)
	}
	if got := m.textarea.Value(); got != "" {
		t.Errorf("input after queueing = %q, want cleared", got)
	}
	if len(m.messages) != before {
		t.Errorf("queueing changed the transcript: %+v", m.messages[before:])
	}

	// The band names the held prompt; a second one is counted, not shown.
	hint := ansiStrip(m.queuedHint())
	if !strings.Contains(hint, "next: second question") {
		t.Errorf("queued hint = %q, want the head of the line", hint)
	}
	m.textarea.SetValue("third question")
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	hint = ansiStrip(m.queuedHint())
	if !strings.Contains(hint, "next: second question") || !strings.Contains(hint, "+1 queued") {
		t.Errorf("queued hint with two held = %q, want head + count", hint)
	}
	if frame := ansiStrip(m.chatView()); !strings.Contains(frame, "next: second question") {
		t.Error("chat frame missing the queued band")
	}
}

// Enter on an empty input mid-turn stays a no-op — no empty queue slots.
func TestEmptyEnterMidTurnNoops(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{llm.DoneEvent{}}}
	m := queueTurnModel(t, p)
	m.streaming = true

	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if len(m.queued) != 0 {
		t.Errorf("empty enter queued %q", m.queued)
	}
}

// When the turn ends, the first queued prompt auto-submits and the next
// turn runs immediately: FIFO, input cleared, queue emptied.
func TestQueuedPromptAutoSubmitsAtTurnEnd(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "turn answer."},
		llm.DoneEvent{},
	}}
	m := queueTurnModel(t, p)

	m.textarea.SetValue("first question")
	m.submit() // turn 1
	m.textarea.SetValue("second question")
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	m.textarea.SetValue("third question")
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)

	m = pumpUntilQuiet(t, m)
	if m.streaming {
		t.Fatal("drained turns never finished")
	}
	if len(m.queued) != 0 {
		t.Errorf("queue = %q, want empty after the drain", m.queued)
	}
	if got := m.textarea.Value(); got != "" {
		t.Errorf("input after the drain = %q, want empty", got)
	}
	// The session saw both queued prompts, in order, after the first.
	var userPrompts []string
	for _, msg := range m.session.Messages() {
		if msg.Role == llm.RoleUser && !strings.HasPrefix(msg.Content, "<task-context>") {
			userPrompts = append(userPrompts, msg.Content)
		}
	}
	want := []string{"first question", "second question", "third question"}
	if len(userPrompts) != len(want) {
		t.Fatalf("session prompts = %q, want %q", userPrompts, want)
	}
	for i, w := range want {
		if userPrompts[i] != w {
			t.Errorf("session prompt %d = %q, want %q", i, userPrompts[i], w)
		}
	}
}

// A queued prompt filed while the first-prompt gatherer runs does not
// gather its own brief: it waits out the gather AND the first turn, then
// goes through as a plain second turn.
func TestQueuedPromptAfterGatherDoesNotReGather(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "brief body."},
		llm.DoneEvent{},
	}}
	m := newGatherModel(t, p) // gatherer ON (config default)
	m = atSize(t, m)

	m.textarea.SetValue("first question")
	m.submit() // gather phase starts (streaming = true)
	m.textarea.SetValue("second question")
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if len(m.queued) != 1 {
		t.Fatalf("queue during gather = %q, want one held prompt", m.queued)
	}

	m = pumpUntilQuiet(t, m)
	briefs, firsts, seconds := 0, 0, 0
	for _, msg := range m.session.Messages() {
		switch {
		case msg.Role == llm.RoleUser && strings.HasPrefix(msg.Content, "<task-context>"):
			briefs++
		case msg.Role == llm.RoleUser && msg.Content == "first question":
			firsts++
		case msg.Role == llm.RoleUser && msg.Content == "second question":
			seconds++
		}
	}
	if briefs != 1 || firsts != 1 || seconds != 1 {
		t.Errorf("session = briefs:%d firsts:%d seconds:%d, want 1/1/1 (the queued prompt must not gather)",
			briefs, firsts, seconds)
	}
	if m.streaming || len(m.queued) != 0 {
		t.Errorf("end state: streaming=%v queue=%q", m.streaming, m.queued)
	}
}

// Esc interrupts the turn AND hands the held prompts back to the input;
// the winding-down stream must not then auto-submit them anyway.
func TestEscRestoresQueuedPrompts(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "slow answer."},
		llm.DoneEvent{},
	}}
	m := queueTurnModel(t, p)

	m.textarea.SetValue("first question")
	m.submit() // turn 1
	turn1 := m.events
	m.textarea.SetValue("second question")
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	m.textarea.SetValue("third question")
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEsc})
	m = next.(Model)
	if got := m.textarea.Value(); got != "second question\n\nthird question" {
		t.Fatalf("input after esc = %q, want the queue restored", got)
	}
	if len(m.queued) != 0 {
		t.Errorf("queue = %q, want emptied by the restore", m.queued)
	}

	// The canceled turn still winds down through finishStream; with the
	// queue handed back there is nothing to drain.
	next, _ = m.Update(streamClosedMsg{})
	m = next.(Model)
	if m.streaming {
		t.Error("stream did not wind down after esc")
	}
	if got := m.textarea.Value(); got != "second question\n\nthird question" {
		t.Errorf("wind-down clobbered the restored draft: %q", got)
	}
	// Let the canceled runner finish its own session writes (the
	// assistant append lands just before its channel closes) before
	// asserting on the transcript.
	for {
		if _, closed := waitForEvents(turn1, nil, nil, nil)().(streamClosedMsg); closed {
			break
		}
	}
	for _, msg := range m.session.Messages() {
		if msg.Role == llm.RoleUser && (msg.Content == "second question" || msg.Content == "third question") {
			t.Errorf("esc-restored prompt %q was sent anyway", msg.Content)
		}
	}
}

// Slash commands typed mid-turn are not queued — they mutate UI state
// the running turn reads — so enter answers with the wait note.
func TestSlashCommandMidTurnWaits(t *testing.T) {
	p := &gatherProvider{once: []llm.Event{
		llm.TextDeltaEvent{Text: "busy."},
		llm.DoneEvent{},
	}}
	m := queueTurnModel(t, p)
	m.streaming = true

	m.textarea.SetValue("/help")
	next, _ := m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if len(m.queued) != 0 {
		t.Errorf("command was queued: %q", m.queued)
	}
	found := false
	for _, msg := range m.messages {
		if msg.role == "system" && strings.Contains(msg.raw, "wait for the current turn") {
			found = true
		}
		if msg.role == "system" && strings.Contains(msg.raw, "/config") {
			t.Error("command ran mid-turn instead of waiting")
		}
	}
	if !found {
		t.Errorf("no wait note appended: %+v", m.messages)
	}
}

// A stream-closed message arriving with no turn live is stale (e.g. an
// abnormal close racing the drain): it must not run finishStream and
// must not touch a queue waiting for nothing.
func TestStaleStreamClosedLeavesQueueAlone(t *testing.T) {
	m := queueTurnModel(t, &gatherProvider{})
	m.streaming = false
	m.queued = []string{"held prompt"}

	next, _ := m.Update(streamClosedMsg{})
	m = next.(Model)
	if len(m.queued) != 1 || m.queued[0] != "held prompt" {
		t.Errorf("stale close disturbed the queue: %q", m.queued)
	}
	if m.streaming {
		t.Error("stale close started a turn")
	}
	for _, msg := range m.messages {
		if strings.HasPrefix(msg.raw, "error: ") {
			t.Errorf("stale close manufactured an error notice: %q", msg.raw)
		}
	}
}
