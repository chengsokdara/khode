package ui

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/tools"

	tea "charm.land/bubbletea/v2"
)

// nameOnlyProvider satisfies Provider for tests that never stream.
type nameOnlyProvider struct{}

func (nameOnlyProvider) Name() string { return "test" }
func (nameOnlyProvider) Stream(_ context.Context, _ llm.Request) (<-chan llm.Event, error) {
	return nil, nil
}

// isolateHome points khode's state dir (~/.khode) at a fresh temp dir
// for the test's duration and clears provider key envs, so persisting
// flows (mode switches, /model, walkthrough commits) can never reach
// the developer's real state — a full test run once overwrote a live
// ~/.khode/config.json with this package's "test" fixture.
func isolateHome(t *testing.T) {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("KHATEWAY_API_KEY", "")
}

// newTestModel builds a Model over a temp session with default tools.
func newTestModel(t *testing.T) Model {
	t.Helper()
	isolateHome(t)
	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return New(cfg, &config.Auth{}, nameOnlyProvider{}, sess,
		tools.Default(t.TempDir()), nil, t.TempDir())
}

// The program runs full screen (alternate buffer): the whole terminal
// is repainted every frame, so overlays erase cleanly and nothing
// leaks into scrollback. The mouse is captured for the wheel: without
// mouse reporting, terminals like iTerm2 scroll their own scrollback
// out from under the alt buffer and the app never sees the tick.
func TestFullScreenView(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	v := m.View()
	if !v.AltScreen {
		t.Error("view is not on the alt screen; overlays cannot erase")
	}
	if v.MouseMode != tea.MouseModeCellMotion {
		t.Errorf("mouse mode = %v, want cell motion (wheel scrolling)", v.MouseMode)
	}
}

// The wheel scrolls the conversation viewport; with an approval dialog
// open it scrolls the dialog body instead and leaves the chat scroll
// alone.
func TestWheelScrolls(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	next, _ = m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelUp})
	m = next.(Model)
	if m.scroll != wheelStep {
		t.Errorf("scroll after wheel up = %d, want %d", m.scroll, wheelStep)
	}
	next, _ = m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = next.(Model)
	if m.scroll != 0 {
		t.Errorf("scroll after wheel down = %d, want 0", m.scroll)
	}
	// Down at the live edge stays clamped.
	next, _ = m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = next.(Model)
	if m.scroll != 0 {
		t.Errorf("scroll below the live edge = %d, want 0", m.scroll)
	}

	req := agent.Request{Kind: agent.KindPlan, Preview: strings.Repeat("- item\n", 60)}
	m.perm = &req
	m.permScroll = 0
	next, _ = m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelDown})
	m = next.(Model)
	if m.permScroll != wheelStep {
		t.Errorf("dialog scroll after wheel down = %d, want %d", m.permScroll, wheelStep)
	}
	next, _ = m.Update(tea.MouseWheelMsg{Button: tea.MouseWheelUp})
	m = next.(Model)
	if m.permScroll != 0 {
		t.Errorf("dialog scroll after wheel up = %d, want 0", m.permScroll)
	}
	if m.scroll != 0 {
		t.Errorf("wheel with a dialog open moved the chat scroll: %d", m.scroll)
	}
}

func TestModifierEnterInsertsNewline(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: 'i', Text: "i"})
	m = next.(Model)

	// shift+enter arrives as a real key on kitty-protocol terminals
	// (bubbletea v2 enables the protocol automatically). It must insert
	// a newline, not submit.
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter, Mod: tea.ModShift})
	m = next.(Model)
	if got := m.textarea.Value(); got != "hi\n" {
		t.Fatalf("shift+enter produced %q, want \"hi\\n\"", got)
	}
	if m.streaming {
		t.Error("shift+enter submitted the turn")
	}

	// The rendered box must show the typed line above the cursor row.
	// (A v2 regression once scrolled it out of view: two empty prompt
	// rows rendered, and the text was only reachable by arrowing up.)
	view := ansiStrip(m.textarea.View())
	lines := strings.Split(view, "\n")
	if len(lines) != 2 || !strings.Contains(lines[0], "❯ hi") {
		t.Fatalf("input box after shift+enter = %q, want the typed line visible above the cursor row", view)
	}
	if !strings.Contains(lines[1], "❯") {
		t.Errorf("second row lost its prompt: %q", lines[1])
	}

	// Submit clears and the box shrinks back to one row, giving the row
	// back to the live region.
	h := m.textarea.Height()
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if m.textarea.Value() != "" {
		t.Errorf("enter did not submit the multi-line input: %q", m.textarea.Value())
	}
	if m.textarea.Height() >= h {
		t.Errorf("input did not shrink after submit: %d rows, want < %d", m.textarea.Height(), h)
	}
}

// ansiStrip removes SGR/CSI escape sequences for content assertions.
func ansiStrip(s string) string { return stripANSI(s) }

func TestPlainEnterSubmits(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	next, _ = m.Update(tea.KeyPressMsg{Code: 'h', Text: "h"})
	m = next.(Model)

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEnter})
	m = next.(Model)
	if got := m.textarea.Value(); got != "" {
		t.Errorf("plain enter did not submit: input = %q", got)
	}
	// This fixture has no credentials, so submit stops at the pre-flight
	// notice instead of appending a user message.
	if n := len(m.messages); n == 0 || !strings.Contains(m.messages[n-1].raw, "no API key") {
		t.Errorf("expected the pre-flight key notice, got %+v", m.messages)
	}
}

// A mid-turn retry explains itself on the status line ("working · … ·
// retry 2/5 · 504 …") instead of a silent spinner, and the note clears
// the moment stream content moves again.
func TestStatusLineShowsRetryNote(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true

	m.handleStreamEvent(llm.RetryEvent{Attempt: 2, Max: 5,
		Err: errors.New(`POST "/v1/chat/completions": 504 upstream timeout`)})
	if got := ansiStrip(m.statusLine()); !strings.Contains(got, "retry 2/5") || !strings.Contains(got, "504") {
		t.Errorf("status line missing the retry note: %q", got)
	}

	m.handleStreamEvent(llm.TextDeltaEvent{Text: "content again"})
	if got := ansiStrip(m.statusLine()); strings.Contains(got, "retry") {
		t.Errorf("retry note survived past the retry: %q", got)
	}
	if !strings.Contains(ansiStrip(m.statusLine()), "working") {
		t.Error("streaming status lost the working state after a retry")
	}
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
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	var sawCall, sawResult, sawFinal bool
	for i, msg := range m.messages {
		out := ansiStrip(m.block(i, 80))
		switch msg.kind {
		case kindToolCall:
			if !strings.Contains(out, "⏺ read") || !strings.Contains(out, "README.md") {
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

// seedTodo writes a list through the real todo tool, so the panel and
// status line read the same state an agent's Exec leaves behind.
func seedTodo(t *testing.T, m Model, items string) {
	t.Helper()
	td, ok := m.tools.Get("todo")
	if !ok {
		t.Fatal("todo tool not registered")
	}
	if _, err := td.Exec(context.Background(), json.RawMessage(`{"items":`+items+`}`)); err != nil {
		t.Fatal(err)
	}
}

// The agent's checklist is one panel, not a transcript of tool calls:
// todo call lines are suppressed, each todo result upserts a single
// kindTodo entry at the live edge with the newest list.
func TestTodoPanelUpsertsInPlace(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	seedTodo(t, m, `[{"content":"one","status":"in_progress"},{"content":"two","status":"pending"}]`)
	m.handleStreamEvent(llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "todo"}})
	m.handleStreamEvent(llm.ToolResultEvent{CallID: "c1", Name: "todo", Output: "❯ one\n☐ two"})

	counts := func() (panels, calls int) {
		for _, msg := range m.messages {
			switch msg.kind {
			case kindTodo:
				panels++
			case kindToolCall:
				calls++
			}
		}
		return panels, calls
	}
	if panels, calls := counts(); panels != 1 || calls != 0 {
		t.Fatalf("after first update: panels=%d calls=%d, want 1 panel, 0 call lines", panels, calls)
	}
	if out := ansiStrip(m.block(len(m.messages)-1, 80)); !strings.Contains(out, "❯ one") ||
		!strings.Contains(out, "☐ two") {
		t.Errorf("panel body = %q", out)
	}

	// The next update replaces the panel: still exactly one, still at
	// the live edge, now showing the newer list.
	seedTodo(t, m, `[{"content":"one","status":"completed"},{"content":"two","status":"in_progress"},{"content":"three","status":"pending"}]`)
	m.handleStreamEvent(llm.ToolResultEvent{CallID: "c2", Name: "todo", Output: "…"})

	if panels, calls := counts(); panels != 1 || calls != 0 {
		t.Fatalf("after second update: panels=%d calls=%d, want 1 panel, 0 call lines", panels, calls)
	}
	last := m.messages[len(m.messages)-1]
	if last.kind != kindTodo {
		t.Fatalf("panel at %v after upsert, want at the live edge", last.kind)
	}
	out := ansiStrip(m.block(len(m.messages)-1, 80))
	for _, want := range []string{"☑ one", "❯ two", "☐ three", "1/3"} {
		if !strings.Contains(out, want) {
			t.Errorf("panel = %q, missing %q", out, want)
		}
	}
}

// An empty list means the agent cleared its tasks: the panel goes away.
func TestTodoPanelClearsOnEmptyList(t *testing.T) {
	m := newTestModel(t)
	seedTodo(t, m, `[{"content":"one","status":"completed"}]`)
	m.handleStreamEvent(llm.ToolResultEvent{CallID: "c1", Name: "todo", Output: "☑ one"})
	seedTodo(t, m, `[]`)
	m.handleStreamEvent(llm.ToolResultEvent{CallID: "c2", Name: "todo", Output: "(task list cleared)"})

	for _, msg := range m.messages {
		if msg.kind == kindTodo {
			t.Error("cleared list left a panel behind")
		}
	}
}

// A rejected todo call (bad status, say) renders as a normal error
// result instead of a panel of stale state.
func TestTodoErrorResultStaysNormal(t *testing.T) {
	m := newTestModel(t)
	m.handleStreamEvent(llm.ToolResultEvent{CallID: "c1", Name: "todo",
		Output:  `items[0]: status "done" must be pending, in_progress, or completed`,
		IsError: true})

	found := false
	for i, msg := range m.messages {
		if msg.kind == kindTodo {
			t.Error("error result rendered as a panel")
		}
		if msg.kind == kindToolResult && msg.isErr {
			found = true
			if out := m.block(i, 80); !strings.Contains(out, "must be pending") {
				t.Errorf("error block = %q", out)
			}
		}
	}
	if !found {
		t.Error("todo error result not rendered as an error block")
	}
}

// While a turn runs, the status line names the task in progress and the
// done/total count; ending the turn clears the current task.
func TestTodoStatusLineShowsTask(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true

	seedTodo(t, m, `[{"content":"wire the handoff","status":"in_progress"},{"content":"write tests","status":"pending"},{"content":"done thing","status":"completed"}]`)
	m.handleStreamEvent(llm.ToolResultEvent{CallID: "c1", Name: "todo", Output: "…"})

	got := ansiStrip(m.statusLine())
	for _, want := range []string{"❯ wire the handoff", "1/3"} {
		if !strings.Contains(got, want) {
			t.Errorf("status line = %q, missing %q", got, want)
		}
	}

	m.handleStreamEvent(llm.DoneEvent{})
	if m.streaming {
		t.Fatal("turn did not finish")
	}
	if m.todoNow != "" {
		t.Errorf("todo task %q survived the turn", m.todoNow)
	}
}

// A resumed transcript shows the final checklist — one panel at the
// last todo update, call lines suppressed — and pairs results to calls
// by id when a round mixes tools and the results interleave.
func TestTodoReplayRendersFinalPanel(t *testing.T) {
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(llm.Message{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{
		{ID: "r1", Name: "read", Input: json.RawMessage(`{"path":"README.md"}`)},
		{ID: "t1", Name: "todo", Input: json.RawMessage(
			`{"items":[{"content":"one","status":"completed"},{"content":"two","status":"in_progress"}]}`)},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(llm.Message{Role: llm.RoleTool,
		ToolResult: &llm.ToolResult{CallID: "t1", Content: "☑ one\n❯ two"}}); err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(llm.Message{Role: llm.RoleTool,
		ToolResult: &llm.ToolResult{CallID: "r1", Content: "file body"}}); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	m := New(cfg, &config.Auth{}, nameOnlyProvider{}, sess, tools.Default(t.TempDir()), nil, t.TempDir())

	panels, callLines, readResults := 0, 0, 0
	for i, msg := range m.messages {
		switch msg.kind {
		case kindTodo:
			panels++
			out := ansiStrip(m.block(i, 80))
			for _, want := range []string{"☑ one", "❯ two", "1/2"} {
				if !strings.Contains(out, want) {
					t.Errorf("replayed panel = %q, missing %q", out, want)
				}
			}
		case kindToolCall:
			callLines++
			if strings.Contains(msg.raw, "todo") {
				t.Errorf("replayed todo call line: %q", msg.raw)
			}
		case kindToolResult:
			readResults++
			if !strings.Contains(msg.raw, "file body") {
				t.Errorf("non-todo result lost: %q", msg.raw)
			}
		}
	}
	if panels != 1 {
		t.Errorf("replayed panels = %d, want 1", panels)
	}
	if callLines != 1 || readResults != 1 {
		t.Errorf("call lines = %d, other results = %d, want 1 each", callLines, readResults)
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
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	var sawThink, sawAnswer bool
	for i, msg := range m.messages {
		out := ansiStrip(m.block(i, 80))
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

	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
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

// khateway lost its keyless pass: with no key anywhere a submitted
// turn is stopped by the pre-flight like every other provider, and the
// pointer offers /login (device sign-in) next to /settings.
func TestKhatewayTurnBlockedWithoutKey(t *testing.T) {
	m := newTestModel(t)
	t.Setenv("KHATEWAY_API_KEY", "")
	m.cfg.Provider = "khateway"
	m.cfg.SetModel("gateway-model")

	m.textarea.SetValue("hello")
	cmd := m.submit()

	if cmd != nil || m.streaming {
		t.Fatal("khateway turn started without a key")
	}
	found := false
	for _, msg := range m.messages {
		if msg.role == "system" && strings.Contains(msg.raw, "/login") && strings.Contains(msg.raw, "/settings") {
			found = true
		}
	}
	if !found {
		t.Errorf("blocked message does not point at /login and /settings: %+v", m.messages)
	}
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

// A skipped walkthrough must not be silent: while a turn would be
// blocked by the pre-flight — no key, or a provider with no model —
// the chat frame carries a persistent setup banner pointing at
// /welcome, /login, or /settings.
func TestSetupBannerShowsWhileUnconfigured(t *testing.T) {
	m := newTestModel(t) // provider "test", model set, no key anywhere
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	hint, _ := m.setupHint()
	if hint = ansiStrip(hint); !strings.Contains(hint, "/welcome") {
		t.Errorf("setup hint = %q, want a /welcome pointer", hint)
	}
	if frame := ansiStrip(m.chatView()); !strings.Contains(frame, "no API key for test") {
		t.Error("chat frame missing the setup banner")
	}

	// A resolvable key clears the banner.
	m.auth.SetKey("test", "sk-test")
	if hint, _ := m.setupHint(); hint != "" {
		t.Errorf("setup hint = %q, want none once a key resolves", hint)
	}

	// khateway names /login as the way out; with a key but no model the
	// banner points at the model picker instead.
	t.Setenv("KHATEWAY_API_KEY", "")
	m.cfg.Provider = "khateway"
	hint, _ = m.setupHint()
	if hint = ansiStrip(hint); !strings.Contains(hint, "/login") {
		t.Errorf("khateway setup hint = %q, want /login", hint)
	}
	m.auth.SetKey("khateway", "khat-key")
	hint, _ = m.setupHint()
	if hint = ansiStrip(hint); !strings.Contains(hint, "/settings") {
		t.Errorf("no-model hint = %q, want the /settings pointer", hint)
	}
}

// Sealed blocks render in the conversation viewport; a streaming block
// renders with the live cursor until it seals.
func TestFlushPrintsSealedBlocks(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, streaming: true, raw: "in flight", history: true})
	m.messages[len(m.messages)-1].streaming = false
	if cmd := m.flush(); cmd != nil {
		t.Error("flush is a no-op in full-screen mode")
	}
	if got := ansiStrip(m.View().Content); !strings.Contains(got, "in flight") {
		t.Errorf("viewport missing the sealed block: %q", got)
	}
	if m.streamingIndex() >= 0 {
		t.Error("sealed block still registered as streaming")
	}
}

// A restored transcript renders on the first resize (the wrap width
// has to exist before anything can render).
func TestStartupTranscriptPrintsOnResize(t *testing.T) {
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range []llm.Message{
		{Role: llm.RoleUser, Content: "earlier question"},
		{Role: llm.RoleAssistant, Content: "earlier answer"},
	} {
		if err := sess.Append(msg); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	m := New(cfg, &config.Auth{}, nameOnlyProvider{}, sess, tools.Default(t.TempDir()), nil, t.TempDir())

	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	printed := ansiStrip(m.View().Content)
	for _, want := range []string{"earlier question", "earlier answer"} {
		if !strings.Contains(printed, want) {
			t.Errorf("viewport missing %q:\n%s", want, printed)
		}
	}
}

// Switching sessions re-prints the header and the picked transcript —
// picked sessions finally show their history.
func TestSessionSwitchPrintsTranscript(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(llm.Message{Role: llm.RoleUser, Content: "picked session history"}); err != nil {
		t.Fatal(err)
	}
	m.useSession(sess)
	m.flush()
	printed := ansiStrip(m.View().Content)
	if !strings.Contains(printed, "picked session history") {
		t.Errorf("switch history = %q, want the picked transcript", printed)
	}
}

// The full-screen frame is exactly the terminal height: shorter leaves
// stale rows painted, taller gets clipped by the renderer.
func TestLiveRegionStaysInsideBudget(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m.streaming = true
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, streaming: true,
		raw: strings.Repeat("line of a long answer\n", 60), history: true})

	rows := strings.Split(m.View().Content, "\n")
	if len(rows) != 30 {
		t.Errorf("frame = %d rows, want exactly 30", len(rows))
	}
}

// The header moved into the scrollback banner, so the status line
// carries the mode chip and model live.
func TestStatusLineShowsModeAndModel(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	status := ansiStrip(m.statusLine())
	if !strings.Contains(status, "ask") {
		t.Errorf("status line missing the mode chip: %q", status)
	}
	if !strings.Contains(status, "test-model") {
		t.Errorf("status line missing the model: %q", status)
	}
}

// pgup/pgdn slide the conversation viewport; pgdown clamps at the live
// edge.
func TestPgUpPgDnScrollViewport(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	next, _ = m.Update(keyMsg("pgup"))
	m = next.(Model)
	if m.scroll <= 0 {
		t.Fatalf("scroll = %d after pgup, want > 0", m.scroll)
	}
	before := m.scroll
	next, _ = m.Update(keyMsg("pgdown"))
	m = next.(Model)
	if m.scroll >= before {
		t.Fatalf("scroll = %d after pgdown, want < %d", m.scroll, before)
	}
	next, _ = m.Update(keyMsg("pgdown"))
	m = next.(Model)
	if m.scroll != 0 {
		t.Fatalf("scroll = %d, want clamped at 0", m.scroll)
	}
}

// The live edge renders in-flight blocks exactly once: messageViewport
// skips streaming blocks in the history loop because streamingBlock
// paints them at the live edge. The old double render showed every
// streaming thinking line — and every answer bar — twice per frame.
func TestStreamingBlocksRenderOnce(t *testing.T) {
	evs := []llm.Event{
		llm.ThinkingDeltaEvent{Text: "weighing options"},
		llm.TextDeltaEvent{Text: "final answer"},
	}
	m := pumpModel(t, newTestModel(t), evs)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	vp, _ := m.messageViewport(30)
	out := ansiStrip(vp)
	if n := strings.Count(out, "weighing options"); n != 1 {
		t.Errorf("thinking text appears %d times in the live frame, want 1:\n%s", n, out)
	}
	if n := strings.Count(out, "final answer"); n != 1 {
		t.Errorf("answer text appears %d times in the live frame, want 1:\n%s", n, out)
	}
}

// An edit result renders as its git-style change: the call line names
// the file only, the diff block pairs the summary with -/+ lines.
func TestEditResultRendersDiff(t *testing.T) {
	evs := []llm.Event{
		llm.ToolCallEvent{ToolCall: llm.ToolCall{
			ID: "c1", Name: "edit",
			Input: json.RawMessage(`{"path":"main.go","old_string":"x := 1","new_string":"x := 2"}`),
		}},
		llm.ToolResultEvent{CallID: "c1", Name: "edit",
			Output: "Edited main.go (1 occurrence, +1 −1 lines)"},
		llm.DoneEvent{},
	}
	m := pumpModel(t, newTestModel(t), evs)

	sawCall, sawDiff := false, false
	for i, msg := range m.messages {
		out := ansiStrip(m.block(i, 80))
		switch msg.kind {
		case kindToolCall:
			sawCall = true
			if !strings.Contains(out, "⏺ edit main.go") || strings.Contains(out, "x := 1") {
				t.Errorf("tool call block = %q, want name + path only", out)
			}
		case kindDiff:
			sawDiff = true
			for _, want := range []string{"⎿  Edited main.go", "-x := 1", "+x := 2"} {
				if !strings.Contains(out, want) {
					t.Errorf("diff block = %q, missing %q", out, want)
				}
			}
		case kindToolResult:
			t.Errorf("edit result rendered as a plain result: %q", out)
		}
	}
	if !sawCall || !sawDiff {
		t.Fatalf("blocks missing: call=%v diff=%v", sawCall, sawDiff)
	}
}

// A failed write-class call keeps the plain red error rendering; the
// banked diff is discarded, not shown.
func TestEditErrorKeepsPlainResult(t *testing.T) {
	evs := []llm.Event{
		llm.ToolCallEvent{ToolCall: llm.ToolCall{
			ID: "c1", Name: "edit",
			Input: json.RawMessage(`{"path":"main.go","old_string":"a","new_string":"b"}`),
		}},
		llm.ToolResultEvent{CallID: "c1", Name: "edit",
			Output: "old_string not found in main.go", IsError: true},
		llm.DoneEvent{},
	}
	m := pumpModel(t, newTestModel(t), evs)

	found := false
	for i, msg := range m.messages {
		switch {
		case msg.kind == kindDiff:
			t.Errorf("errored edit rendered as a diff: %q", ansiStrip(m.block(i, 80)))
		case msg.kind == kindToolResult && msg.isErr:
			found = true
			if out := ansiStrip(m.block(i, 80)); !strings.Contains(out, "not found") {
				t.Errorf("error block = %q", out)
			}
		}
	}
	if !found {
		t.Error("error result block missing")
	}
}

// Resumed sessions replay write-class results as diffs too, mirroring
// what the live turn showed.
func TestEditReplayRendersDiff(t *testing.T) {
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(llm.Message{Role: llm.RoleAssistant, ToolCalls: []llm.ToolCall{
		{ID: "w1", Name: "write", Input: json.RawMessage(`{"path":"new.txt","content":"hi\n"}`)},
	}}); err != nil {
		t.Fatal(err)
	}
	if err := sess.Append(llm.Message{Role: llm.RoleTool,
		ToolResult: &llm.ToolResult{CallID: "w1", Content: "Wrote new.txt (1 line)"}}); err != nil {
		t.Fatal(err)
	}

	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	m := New(cfg, &config.Auth{}, nameOnlyProvider{}, sess, tools.Default(t.TempDir()), nil, t.TempDir())

	sawDiff := false
	for i, msg := range m.messages {
		if msg.kind != kindDiff {
			continue
		}
		sawDiff = true
		out := ansiStrip(m.block(i, 80))
		for _, want := range []string{"⎿  Wrote new.txt", "+hi"} {
			if !strings.Contains(out, want) {
				t.Errorf("replayed diff block = %q, missing %q", out, want)
			}
		}
	}
	if !sawDiff {
		t.Error("replayed write rendered no diff block")
	}
}

// Streaming prose often pauses inside an unfinished markdown construct
// (an unclosed fence, a started list or heading), which glamour renders
// as an empty final row — left alone that row paints a bar-only line
// that reads as a second vertical rule beside the text (and a
// whitespace-only raw paints nothing at all). No assistant block may
// ever end in, or consist solely of, a bar-only row.
func TestAnswerBarNeverEndsInBareBar(t *testing.T) {
	m := newTestModel(t)
	raws := []string{
		"document both options. Let me start scaffolding:",
		"text\n```",
		"text\n```go\n",
		"text\n- ",
		"text\n> ",
		"text\n---",
		"text\n# ",
		"text\n\n\n",
		" ",
		"\n",
		"",
	}
	for _, raw := range raws {
		for _, streaming := range []bool{false, true} {
			m.messages = append(m.messages, uiMessage{
				role: llm.RoleAssistant, kind: kindText, raw: raw, streaming: streaming,
			})
			out := ansiStrip(m.block(len(m.messages)-1, 100))
			lines := strings.Split(out, "\n")
			for i, l := range lines {
				if strings.TrimSpace(l) == "┃" {
					t.Errorf("raw=%q streaming=%v: line %d is bar-only: %q", raw, streaming, i, out)
				}
			}
			m.messages = m.messages[:len(m.messages)-1]
		}
	}
}

// A whitespace-only text delta between thinking phases (some models emit
// them) must not leave a sealed empty block behind: the switch drops it.
func TestWhitespaceDeltaLeavesNoEmptyBlock(t *testing.T) {
	evs := []llm.Event{
		llm.ThinkingDeltaEvent{Text: "plan first"},
		llm.TextDeltaEvent{Text: " "},
		llm.TextDeltaEvent{Text: "\n"},
		llm.ThinkingDeltaEvent{Text: "back to reasoning"},
		llm.TextDeltaEvent{Text: "real answer"},
	}
	m := pumpModel(t, newTestModel(t), evs)

	for i, msg := range m.messages {
		if msg.kind == kindText && strings.TrimSpace(msg.raw) == "" {
			t.Errorf("msg[%d]: whitespace-only text block survived", i)
		}
	}
	var answer string
	for _, msg := range m.messages {
		if msg.kind == kindText {
			answer = msg.raw
		}
	}
	if answer != "real answer" {
		t.Errorf("answer = %q, want the post-whitespace text only", answer)
	}
}

// Activity appended after the streaming block (a todo panel refresh, a
// compaction notice) must not freeze its raw updates: deltas target the
// open streaming block wherever it sits.
func TestDeltaTargetsStreamingBlockPastActivity(t *testing.T) {
	m := newTestModel(t)
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, kind: kindText, raw: "hello", streaming: true})
	m.partial.WriteString("hello")
	m.messages = append(m.messages, uiMessage{role: llm.RoleTool, kind: kindTodo, raw: "❯ task"})

	m.handleStreamEvent(llm.TextDeltaEvent{Text: " world"})

	if got := m.messages[0].raw; got != "hello world" {
		t.Errorf("streaming block raw = %q, want %q", got, "hello world")
	}
}

// Tool call lines read as commands and paths, not raw JSON: bash shows
// its command flattened to one line, read shows the path, and only
// shapeless tools fall back to the compacted JSON.
func TestToolCallLinesAreReadable(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{"bash", `{"command":"mkdir -p a\nb && echo hi","timeout":30000}`, "bash mkdir -p a b && echo hi"},
		{"read", `{"path":"cmd/khode/main.go"}`, "read cmd/khode/main.go"},
		{"glob", `{"pattern":"**/*.go"}`, "glob **/*.go"},
		{"plan", `{"plan":"## Step 1"}`, "plan"},
		{"mcp__x__y", `{"q":"z"}`, `mcp__x__y {"q":"z"}`},
	}
	for _, c := range cases {
		got := formatToolCall(llm.ToolCall{ID: "c1", Name: c.name, Input: json.RawMessage(c.input)})
		if got != c.want {
			t.Errorf("formatToolCall(%s) = %q, want %q", c.name, got, c.want)
		}
	}
}

// Diff code is syntax-highlighted in the aurora palette (VSCode-style):
// a JS write diff lexes as JavaScript — keywords cyan, strings amber —
// while the + marker stays green, and a file without a lexer keeps the
// code plain.
func TestDiffHighlightsCode(t *testing.T) {
	diff := "@@ -0,0 +1,3 @@\n" +
		"+const router = require('express');\n" +
		"+// fetch all todos\n" +
		"+router.get('/', handler);\n"
	out := diffBlock("Wrote routes/todos.js (3 lines)", diff, "routes/todos.js", 100, false)
	for _, want := range []string{
		"\x1b[38;2;94;234;212m", // keyword cyan (#5EEAD4) — const/router
		"\x1b[38;2;251;191;36m", // string amber (#FBBF24) — 'express'
		"\x1b[38;2;92;107;115m", // comment dim (#5C6B73)
		addStyle.Render("+"),    // the green marker
	} {
		if !strings.Contains(out, want) {
			t.Errorf("highlighted diff missing %q: %q", want, ansiStrip(out))
		}
	}

	plain := diffBlock("Wrote data.blob (1 line)", "@@ -0,0 +1,1 @@\n+const x = 1;\n", "data.blob", 100, false)
	if strings.Contains(plain, "\x1b[38;2;94;234;212m") {
		t.Errorf("lexerless file unexpectedly highlighted: %q", ansiStrip(plain))
	}
}

// ctrl+o expands the most recent truncated block — a tool result's full
// output — and collapses it again.
func TestCtrlOExpandsResult(t *testing.T) {
	var lines []string
	for i := 1; i <= 10; i++ {
		lines = append(lines, fmt.Sprintf("detail line %d", i))
	}
	evs := []llm.Event{
		llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "bash",
			Input: json.RawMessage(`{"command":"verbose-cmd"}`)}},
		llm.ToolResultEvent{CallID: "c1", Name: "bash",
			Output: strings.Join(lines, "\n"), IsError: true},
		llm.DoneEvent{},
	}
	m := pumpModel(t, newTestModel(t), evs)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	if out := ansiStrip(m.block(1, 100)); !strings.Contains(out, "(+8 more lines · ctrl+o)") {
		t.Errorf("collapsed error block = %q", out)
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl})
	m = next.(Model)
	out := ansiStrip(m.block(1, 100))
	for _, want := range []string{"detail line 1", "detail line 10", "ctrl+o to collapse"} {
		if !strings.Contains(out, want) {
			t.Errorf("expanded error block missing %q: %q", want, out)
		}
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl})
	m = next.(Model)
	if out := ansiStrip(m.block(1, 100)); strings.Contains(out, "detail line 10") {
		t.Errorf("collapsed block still shows detail: %q", out)
	}
}

// A capped diff expands the same way: ctrl+o reveals every diff line.
func TestCtrlOExpandsDiff(t *testing.T) {
	var b strings.Builder
	fmt.Fprint(&b, "@@ -0,0 +1,30 @@\n")
	for i := 1; i <= 30; i++ {
		fmt.Fprintf(&b, "+line %d\n", i)
	}
	m := newTestModel(t)
	m.messages = append(m.messages, uiMessage{
		role: llm.RoleTool, kind: kindDiff, raw: "Wrote big.txt (30 lines)",
		diff: b.String(), path: "big.txt", history: true,
	})
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// The @@ header counts toward the cap: 20 drawn lines (header +
	// 19 content), 11 hidden.
	if out := ansiStrip(m.block(0, 100)); !strings.Contains(out, "… 11 more diff lines · ctrl+o to expand") {
		t.Errorf("collapsed diff = %q", out)
	}
	next, _ = m.Update(tea.KeyPressMsg{Code: 'o', Mod: tea.ModCtrl})
	m = next.(Model)
	out := ansiStrip(m.block(0, 100))
	if !strings.Contains(out, "line 30") {
		t.Errorf("expanded diff missing the tail: %q", out)
	}
	if !strings.Contains(out, "ctrl+o to collapse") {
		t.Errorf("expanded diff missing the collapse hint: %q", out)
	}
}

// Truncated blocks are clickable: pressing the region registered for an
// expandable block toggles its detail.
func TestClickTogglesExpand(t *testing.T) {
	m := newTestModel(t)
	m.messages = append(m.messages, uiMessage{
		role: llm.RoleTool, kind: kindToolResult, isErr: true,
		raw: "one\ntwo\nthree\nfour", history: true,
	})
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m = clickAt(t, m, func(r region) bool { return r.kind == clickExpand })
	if !m.messages[0].expanded {
		t.Error("click did not expand the truncated result")
	}
	m = clickAt(t, m, func(r region) bool { return r.kind == clickExpand })
	if m.messages[0].expanded {
		t.Error("click did not collapse the expanded result")
	}
}
