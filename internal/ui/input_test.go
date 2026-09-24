package ui

import (
	"strings"
	"testing"

	"charm.land/bubbles/v2/textarea"
	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/tools"

	tea "charm.land/bubbletea/v2"
)

// TestInputHistoryRecallCycle drives ↑/↓ through handleKey: newest
// first, oldest stops the walk, ↓ past the newest lands back on an
// empty draft.
func TestInputHistoryRecallCycle(t *testing.T) {
	m := newTestModel(t)
	m.rememberInput("first prompt")
	m.rememberInput("second prompt")

	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "second prompt" {
		t.Errorf("first ↑ loaded %q, want the newest entry", got)
	}
	if m.textarea.Line() != 0 || m.textarea.Column() != len("second prompt") {
		t.Errorf("cursor after ↑ = %d:%d, want end of the entry", m.textarea.Line(), m.textarea.Column())
	}

	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "first prompt" {
		t.Errorf("second ↑ loaded %q, want the oldest entry", got)
	}
	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "first prompt" {
		t.Errorf("↑ past the oldest changed the input to %q", got)
	}

	m = pressKey(t, m, tea.KeyDown)
	if got := m.textarea.Value(); got != "second prompt" {
		t.Errorf("↓ walked forward to %q", got)
	}
	m = pressKey(t, m, tea.KeyDown)
	if got := m.textarea.Value(); got != "" {
		t.Errorf("↓ past the newest left %q, want the empty draft", got)
	}
}

// TestInputHistoryDraftStash checks the shell convention: ↑ stashes
// the half-typed draft and ↓ past the newest entry brings it back.
func TestInputHistoryDraftStash(t *testing.T) {
	m := newTestModel(t)
	m.rememberInput("an older prompt")
	m.textarea.SetValue("half-typed dr")
	m.textarea.MoveToEnd()

	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "an older prompt" {
		t.Fatalf("↑ loaded %q, want the history entry", got)
	}
	m = pressKey(t, m, tea.KeyDown)
	if got := m.textarea.Value(); got != "half-typed dr" {
		t.Errorf("↓ past the newest restored %q, want the stashed draft", got)
	}
	if m.textarea.Column() != len("half-typed dr") {
		t.Errorf("restored draft cursor = %d, want parked at the end", m.textarea.Column())
	}
}

// TestInputHistoryMultilineGating pins the line-aware split: on a
// multi-line draft ↑/↓ move the cursor between lines; only the first
// line recalls up and only the last line recalls down.
func TestInputHistoryMultilineGating(t *testing.T) {
	m := newTestModel(t)
	m.rememberInput("recalled entry")
	m.textarea.SetValue("line one\nline two")
	m.textarea.MoveToEnd() // cursor on the last line

	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "line one\nline two" {
		t.Fatalf("↑ from the last line recalled %q, want a cursor move", got)
	}
	if m.textarea.Line() != 0 {
		t.Fatalf("↑ from the last line = line %d, want the cursor moved to line 0", m.textarea.Line())
	}
	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "recalled entry" {
		t.Errorf("↑ from the first line did not recall, input = %q", got)
	}

	// Back down through history, then the restored draft's first line:
	// ↓ must move within the draft before it ever restores it.
	m.textarea.SetValue("line one\nline two")
	m.rememberInput("line one\nline two")
	m.textarea.MoveToBegin()
	m = pressKey(t, m, tea.KeyDown)
	if m.textarea.Line() != 1 {
		t.Fatalf("↓ on the first line = line %d, want a cursor move to line 1", m.textarea.Line())
	}
	if got := m.textarea.Value(); got != "line one\nline two" {
		t.Errorf("↓ from the first line changed the input to %q", got)
	}
}

// TestInputHistorySeededFromTranscript: --resume recalls the prompts
// the session actually sent, consecutive repeats collapsed.
func TestInputHistorySeededFromTranscript(t *testing.T) {
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for _, msg := range []llm.Message{
		{Role: llm.RoleUser, Content: "q1"},
		{Role: llm.RoleAssistant, Content: "a1"},
		{Role: llm.RoleUser, Content: "q2"},
		{Role: llm.RoleUser, Content: "q2"}, // replayed retry: collapse
		{Role: llm.RoleAssistant, Content: "a2"},
	} {
		if err := sess.Append(msg); err != nil {
			t.Fatal(err)
		}
	}
	cfg := &config.Config{Provider: "test", MaxTokens: 100}
	cfg.SetModel("test-model")
	m := New(cfg, &config.Auth{}, nameOnlyProvider{}, sess, tools.Default(t.TempDir()), nil, t.TempDir())

	if got := strings.Join(m.inputHistory, "|"); got != "q1|q2" {
		t.Errorf("seeded history = %q, want %q", got, "q1|q2")
	}

	// And the recall walks the seeded entries.
	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "q2" {
		t.Errorf("↑ after resume loaded %q, want q2", got)
	}
	m = pressKey(t, m, tea.KeyUp)
	if got := m.textarea.Value(); got != "q1" {
		t.Errorf("second ↑ loaded %q, want q1", got)
	}
}

// TestRememberInputDedupes: resending the same prompt must not crowd
// the buffer with repeats, but revisiting an older prompt later is kept.
func TestRememberInputDedupes(t *testing.T) {
	m := newTestModel(t)
	m.rememberInput("same")
	m.rememberInput("same")
	if len(m.inputHistory) != 1 {
		t.Fatalf("consecutive duplicates kept: %v", m.inputHistory)
	}
	m.rememberInput("other")
	m.rememberInput("same")
	if len(m.inputHistory) != 3 || m.inputHistory[2] != "same" {
		t.Errorf("history = %v, want the repeated entry kept at the end", m.inputHistory)
	}
}

// pressKey sends one key press through Update, the way the real loop
// delivers them.
func pressKey(t *testing.T, m Model, code rune) Model {
	t.Helper()
	next, _ := m.Update(tea.KeyPressMsg{Code: code})
	return next.(Model)
}

// TestWrapRunesBasics pins the mirrored wrap on hand-traced inputs.
// Every row carries the wrap algorithm's trailing-space fiction; row
// runes total the input's runes plus one per row.
func TestWrapRunesBasics(t *testing.T) {
	cases := []struct {
		name  string
		input string
		width int
		want  []string
	}{
		{"short line fits", "hi", 10, []string{"hi "}},
		{"empty input still one row", "", 10, []string{" "}},
		{"word wrap", "hello world", 10, []string{"hello ", "world "}},
		{"long word splits", "abcdefghij", 4, []string{"abcd", "efgh", "ij "}},
	}
	for _, tc := range cases {
		segs := wrapRunes([]rune(tc.input), tc.width)
		if len(segs) != len(tc.want) {
			t.Errorf("%s: wrapRunes(%q, %d) = %d rows, want %d (%q)",
				tc.name, tc.input, tc.width, len(segs), len(tc.want), tc.want)
			continue
		}
		for i, want := range tc.want {
			if got := string(segs[i]); got != want {
				t.Errorf("%s: row %d = %q, want %q", tc.name, i, got, want)
			}
		}
	}

	// Conservation on a mixed sweep: the wrap output holds every input
	// rune plus exactly one trailing-space fiction, wherever it landed.
	for _, in := range []string{"a b c", "  padded  ", "lorem ipsum dolor sit amet", "好好 ok 好好"} {
		for _, w := range []int{1, 3, 5, 8, 20} {
			segs := wrapRunes([]rune(in), w)
			total := 0
			for _, seg := range segs {
				if len(seg) == 0 {
					t.Errorf("wrapRunes(%q, %d) produced an empty row", in, w)
				}
				total += len(seg)
			}
			if want := len([]rune(in)) + 1; total != want {
				t.Errorf("wrapRunes(%q, %d): %d rows hold %d runes, want %d",
					in, w, len(segs), total, want)
			}
		}
	}
}

// TestWrapRunesMatchesTextarea: the mirror must agree with the real
// textarea about how many visual rows each logical line wraps into at
// the current width — that agreement is what click mapping lives on.
// CursorUp walks visual rows, so the walk goes bottom-up line by line.
func TestWrapRunesMatchesTextarea(t *testing.T) {
	ta := textarea.New()
	ta.ShowLineNumbers = false
	const w = 20
	ta.SetWidth(w)
	value := "the quick brown fox jumps over the lazy dog\nshort\n好 tricky widths here"
	ta.SetValue(value)

	lines := strings.Split(value, "\n")
	ta.MoveToEnd()
	for i := len(lines) - 1; i >= 0; i-- {
		for ta.Line() > i {
			ta.CursorUp()
		}
		if got, want := len(wrapRunes([]rune(lines[i]), w)), ta.LineInfo().Height; got != want {
			t.Errorf("line %d (%q): wrapRunes rows = %d, textarea LineInfo height = %d",
				i, lines[i], got, want)
		}
	}
}

// TestHitToCursorMapsClicks: clicks map back to the logical line and
// rune column the pressed cell shows, clamping past the text.
func TestHitToCursorMapsClicks(t *testing.T) {
	cases := []struct {
		name    string
		value   string
		width   int
		gridRow int
		col     int
		line    int
		runeCol int
	}{
		{"start of text", "hello world", 10, 0, 0, 0, 0},
		{"mid first row", "hello world", 10, 0, 3, 0, 3},
		{"second row start", "hello world", 10, 1, 0, 0, 6},
		{"into second row", "hello world", 10, 1, 2, 0, 8},
		{"past end of text", "hello world", 10, 5, 0, 0, 11},
		{"past the row's text", "hello world", 10, 0, 99, 0, 6},
		{"second logical line", "one two\nthree", 7, 2, 1, 1, 1},
		{"empty input", "", 10, 0, 0, 0, 0},
		{"wide runes", "你好", 5, 0, 2, 0, 1},
	}
	for _, tc := range cases {
		line, col := hitToCursor(tc.value, tc.width, tc.gridRow, tc.col)
		if line != tc.line || col != tc.runeCol {
			t.Errorf("%s: hitToCursor(%q, %d, row %d, col %d) = %d:%d, want %d:%d",
				tc.name, tc.value, tc.width, tc.gridRow, tc.col, line, col, tc.line, tc.runeCol)
		}
	}
}

// TestPlaceInputCursor drives the real textarea: a click lands the
// cursor on the right logical line and column, including past-the-end
// clamps.
func TestPlaceInputCursor(t *testing.T) {
	m := newTestModel(t)
	m.textarea.SetWidth(10)
	m.textarea.SetValue("hello world")
	m.placeInputCursor(0, 3)
	if m.textarea.Line() != 0 || m.textarea.Column() != 3 {
		t.Errorf("click at row 0 col 3 = %d:%d, want 0:3", m.textarea.Line(), m.textarea.Column())
	}
	m.placeInputCursor(1, 2)
	if m.textarea.Line() != 0 || m.textarea.Column() != 8 {
		t.Errorf("click at row 1 col 2 = %d:%d, want 0:8", m.textarea.Line(), m.textarea.Column())
	}
	m.placeInputCursor(9, 0)
	if got := (pos{m.textarea.Line(), m.textarea.Column()}); got != (pos{0, 11}) {
		t.Errorf("click below the text = %d:%d, want 0:11 (end)", got.line, got.col)
	}

	m.textarea.SetValue("one two\nthree")
	m.textarea.SetWidth(7) // forces the first line onto two visual rows
	m.placeInputCursor(2, 1)
	if m.textarea.Line() != 1 || m.textarea.Column() != 1 {
		t.Errorf("click on second line = %d:%d, want 1:1", m.textarea.Line(), m.textarea.Column())
	}
}

// pos names a cursor spot for readable assertions.
type pos struct{ line, col int }

// TestPlaceInputCursorScrolled: beyond the height cap the textarea
// scrolls internally, and a visible row maps through ScrollYOffset —
// clicking the top visible row of a scrolled 8-line input lands on the
// third logical line.
func TestPlaceInputCursorScrolled(t *testing.T) {
	m := newTestModel(t)
	m.textarea.SetWidth(10)
	m.textarea.SetValue("a\nb\nc\nd\ne\nf\ng\nh")
	// In the live app every keystroke runs textarea.Update, which sizes
	// the viewport and feeds it the rendered rows; pump one so the
	// internal scroll exists for MoveToEnd to position.
	m.textarea.Update(tea.KeyPressMsg{Code: tea.KeyF1})
	m.textarea.MoveToEnd() // 8 visual rows in a 6-row box: scrolled back 2
	if got := m.textarea.ScrollYOffset(); got != 2 {
		t.Fatalf("ScrollYOffset after MoveToEnd = %d, want 2", got)
	}
	m.placeInputCursor(0, 0)
	if m.textarea.Line() != 2 || m.textarea.Column() != 0 {
		t.Errorf("clicked top visible row = %d:%d, want 2:0", m.textarea.Line(), m.textarea.Column())
	}
}

// TestInputClickEndToEnd renders the frame and clicks the input box
// itself: the region dispatch places the cursor at the pressed column.
func TestInputClickEndToEnd(t *testing.T) {
	m := sizedModel(t)
	m.textarea.SetValue(strings.Repeat("x", 60))
	m = clickAt(t, m, func(r region) bool { return r.kind == clickInput && r.idx == 0 })
	// clickAt presses the middle of the 100-col frame: column 50 minus
	// the border and the two-column prompt.
	if m.textarea.Line() != 0 || m.textarea.Column() != 47 {
		t.Errorf("clicked cursor = %d:%d, want 0:47", m.textarea.Line(), m.textarea.Column())
	}
}
