package ui

import (
	"context"
	"encoding/json"
	"regexp"
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

// The program is inline: the view declares no alt screen and no mouse
// capture, so the terminal keeps its native scrollback, wheel, and
// selection — the whole point of printing sealed turns into it.
func TestInlineViewDeclaresNothing(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	v := m.View()
	if v.AltScreen {
		t.Error("view entered the alt screen; scrollback would be suspended")
	}
	if v.MouseMode != tea.MouseModeNone {
		t.Errorf("mouse mode = %v, want none (native wheel/selection)", v.MouseMode)
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
func ansiStrip(s string) string {
	re := regexp.MustCompile(`\x1b\[[0-9;:]*[a-zA-Z]`)
	return re.ReplaceAllString(s, "")
}

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
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

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

// flush hands sealed blocks to the terminal's scrollback in one chunk
// and advances the watermark; a streaming block is never printed.
func TestFlushPrintsSealedBlocks(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model) // first flush: the banner

	// A streaming block is never printed: flush has nothing to do.
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, streaming: true, raw: "in flight", history: true})
	if cmd := m.flush(); cmd != nil {
		t.Error("flush printed while the last block was still streaming")
	}
	// Sealing it makes it printable; the chunk carries the final text.
	m.messages[len(m.messages)-1].streaming = false
	if cmd := m.flush(); cmd == nil {
		t.Fatal("flush printed nothing after the block sealed")
	}
	if got := ansiStrip(m.lastPrint); !strings.Contains(got, "in flight") {
		t.Errorf("printed chunk = %q, want the sealed block", got)
	}
	if m.printed != len(m.messages) {
		t.Errorf("watermark = %d, want %d", m.printed, len(m.messages))
	}
	if got := ansiStrip(m.View().Content); strings.Contains(got, "in flight") {
		t.Error("printed block still rendered in the live region")
	}
}

// A restored transcript prints once, banner first, on the first resize
// (the wrap width has to exist before anything can print), and none of
// it stays in the live region.
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

	if m.printed != 0 || m.lastPrint != "" {
		t.Fatalf("transcript printed before any resize: printed=%d", m.printed)
	}
	next, cmd := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	if cmd == nil {
		t.Fatal("first resize must flush the banner + transcript")
	}
	printed := ansiStrip(m.lastPrint)
	for _, want := range []string{"khode", "earlier question", "earlier answer"} {
		if !strings.Contains(printed, want) {
			t.Errorf("startup chunk missing %q:\n%s", want, printed)
		}
	}
	if m.printed != len(m.messages) {
		t.Errorf("watermark = %d, want %d", m.printed, len(m.messages))
	}
	if got := ansiStrip(m.View().Content); strings.Contains(got, "earlier answer") {
		t.Error("printed transcript leaked into the live region")
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
	if cmd := m.flush(); cmd == nil {
		t.Fatal("session switch printed nothing")
	}
	printed := ansiStrip(m.lastPrint)
	if !strings.Contains(printed, "khode") || !strings.Contains(printed, "picked session history") {
		t.Errorf("switch chunk = %q, want banner + transcript", printed)
	}
}

// The live region — streaming blocks, popup, input — must never fill
// the terminal: bubbletea's Println garbles a full-height frame, and
// taller frames get clipped by the renderer.
func TestLiveRegionStaysInsideBudget(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m.streaming = true
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, streaming: true,
		raw: strings.Repeat("line of a long answer\n", 60), history: true})
	m = pressKeys(m, "/") // popup open on top of the tall stream

	v := m.View()
	lines := strings.Split(v.Content, "\n")
	if len(lines) > m.height-2 {
		t.Errorf("live frame = %d rows, want <= %d (terminal %d minus safety)", len(lines), m.height-2, m.height)
	}
	if !strings.Contains(ansiStrip(v.Content), "line of a long answer") {
		t.Error("streaming text vanished from the live region")
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
