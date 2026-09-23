package ui

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/tools"
)

// Sealed assistant prose must come out of glamour styled (ANSI present,
// markdown markers gone) with paragraphs still separated by blank lines.
func TestRenderMarkdownAuroraTheme(t *testing.T) {
	out := renderMarkdown("# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\npara one\n\npara two\n", 80)
	t.Logf("rendered:\n%s", ansiStrip(out))
	if !strings.Contains(out, "\x1b[") {
		t.Error("markdown rendered without any ANSI styling — theme not applied")
	}
	stripped := ansiStrip(out)
	for _, leak := range []string{"**", "```"} {
		if strings.Contains(stripped, leak) {
			t.Errorf("markdown marker %q leaked into the render: %q", leak, stripped)
		}
	}
	for _, want := range []string{"Title", "bold", "para one", "para two"} {
		if !strings.Contains(stripped, want) {
			t.Errorf("render missing %q:\n%s", want, stripped)
		}
	}
	// glamour pads lines out to the wrap width, so normalize before
	// asserting on line structure.
	var lines []string
	for _, ln := range strings.Split(stripped, "\n") {
		lines = append(lines, strings.TrimRight(ln, " "))
	}
	flat := strings.Join(lines, "\n")
	if !strings.Contains(flat, "para one\n\npara two") {
		t.Errorf("paragraphs lost their separating blank line:\n%s", flat)
	}
}

// User messages ride a full-width dark-green slab (green = you vs
// khode's cyan bars): the ❯ lands inside the band and every padded
// line — wrapped or blank — carries the background, so multi-line
// input reads as one card.
func TestUserMessageRendersSlab(t *testing.T) {
	m := newTestModel(t)
	m.messages = append(m.messages, uiMessage{
		role: llm.RoleUser,
		raw:  "fix the mobile login bug\n\nthe token expires too early",
	})
	out := m.block(0, 60)
	// #123524 is the slab background: 18, 53, 36 in SGR terms.
	if !strings.Contains(out, "48;2;18;53;36") {
		t.Errorf("user message missing the slab background: %q", out)
	}
	if !strings.Contains(ansiStrip(out), "❯ fix the mobile login bug") {
		t.Errorf("slab lost the prompt mark or text: %s", ansiStrip(out))
	}
	if got := len(strings.Split(ansiStrip(out), "\n")); got != 3 {
		t.Errorf("multi-line slab rendered %d lines, want 3 (both paragraphs on the band)", got)
	}
}

// Streaming text rides the same markdown pipeline as sealed prose, with
// the cursor trailing the last line. Nothing may land in the render
// cache while streaming: the seal must produce the sealed view, not
// replay a cursor-trailed body (which would strand cursors mid-history
// and skip the answer bar).
func TestStreamingTextRendersMarkdownLive(t *testing.T) {
	m := newTestModel(t)
	m.messages = append(m.messages, uiMessage{
		role: llm.RoleAssistant, kind: kindText, streaming: true,
		raw: "# heading\nbody text",
	})

	live := m.block(0, 80)
	if !strings.Contains(live, "▌") {
		t.Errorf("live block lost the streaming cursor: %q", live)
	}
	// #86EFAC is the aurora H1 color: the heading must be styled.
	if !strings.Contains(live, "38;2;134;239;172") {
		t.Errorf("live block did not render markdown: %q", live)
	}
	if m.messages[0].rendered != "" {
		t.Error("streaming render leaked into the render cache")
	}

	// Growing the raw must change the render — nothing cached.
	m.messages[0].raw = "# heading\nbody text\n\nsecond para"
	if got := m.block(0, 80); !strings.Contains(ansiStrip(got), "second para") {
		t.Errorf("growing raw did not change the live render: %q", got)
	}

	m.messages[0].streaming = false
	sealed := m.block(0, 80)
	if strings.Contains(sealed, "▌") {
		t.Errorf("sealed block kept the streaming cursor: %q", sealed)
	}
	if m.messages[0].rendered == "" {
		t.Error("sealed render was not cached")
	}
}

// The turn's final answer renders under the bright cyan bar; mid-turn
// text stays under the dim one.
func TestFinalAnswerRendersUnderBrightBar(t *testing.T) {
	evs := []llm.Event{
		llm.TextDeltaEvent{Text: "checking first"},
		llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "c1", Name: "read", Input: json.RawMessage(`{}`)}},
		llm.ToolResultEvent{CallID: "c1", Name: "read", Output: "ok"},
		llm.TextDeltaEvent{Text: "the real answer"},
	}
	m := pumpModel(t, newTestModel(t), evs)

	var texts []*uiMessage
	for i := range m.messages {
		msg := &m.messages[i]
		if msg.role == llm.RoleAssistant && msg.kind == kindText {
			texts = append(texts, msg)
		}
	}
	if len(texts) != 2 {
		t.Fatalf("assistant text blocks = %d, want 2", len(texts))
	}
	if texts[0].final {
		t.Error("mid-turn text was marked final")
	}
	if !texts[1].final {
		t.Error("turn's last text block was not marked final")
	}
	// #2DD4BF is the final bar; #24544E the dim one.
	if out := m.block(len(m.messages)-1, 80); !strings.Contains(out, "\x1b[38;2;45;212;191m┃") {
		t.Errorf("final answer not under the bright bar: %q", out)
	}
	if out := m.block(0, 80); !strings.Contains(out, "\x1b[38;2;36;84;78m┃") {
		t.Errorf("mid-turn text not under the dim bar: %q", out)
	}
}

// An errored turn keeps its prose off the bright bar — the failure note
// is the loud end, not the last text.
func TestErroredTurnHasNoFinalBar(t *testing.T) {
	evs := []llm.Event{
		llm.TextDeltaEvent{Text: "partial thought"},
		llm.ErrorEvent{Err: errors.New("boom")},
	}
	m := pumpModel(t, newTestModel(t), evs)
	for i := range m.messages {
		if m.messages[i].role == llm.RoleAssistant && m.messages[i].kind == kindText && m.messages[i].final {
			t.Error("errored turn marked its text final")
		}
	}
}

// A replayed transcript marks every turn's closing answer, not just the
// transcript's last message, so --resume looks like the live session.
func TestReplayMarksPerTurnFinalAnswers(t *testing.T) {
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range []llm.Message{
		{Role: llm.RoleUser, Content: "q1"},
		{Role: llm.RoleAssistant, Content: "a1"},
		{Role: llm.RoleUser, Content: "q2"},
		{Role: llm.RoleAssistant, Content: "mid", ToolCalls: []llm.ToolCall{{ID: "c1", Name: "read"}}},
		{Role: llm.RoleTool, ToolResult: &llm.ToolResult{CallID: "c1"}, Content: "r"},
		{Role: llm.RoleAssistant, Content: "a2"},
	} {
		if err := sess.Append(msg); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	m := New(cfg, &config.Auth{}, nameOnlyProvider{}, sess, tools.Default(t.TempDir()), nil, t.TempDir())

	var finals []string
	for _, msg := range m.messages {
		if msg.role == llm.RoleAssistant && msg.kind == kindText && msg.final {
			finals = append(finals, msg.raw)
		}
	}
	if len(finals) != 2 || finals[0] != "a1" || finals[1] != "a2" {
		t.Errorf("final answers = %v, want [a1 a2]", finals)
	}
}
