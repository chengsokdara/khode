package ui

import (
	"strings"
	"testing"

	"khode/internal/config"
	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
)

func TestShiftTabCyclesMode(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// The walk is the Modes() ladder from ask back to ask, and each
	// press persists without appending a chat notice (the mode line is
	// the feedback).
	messagesBefore := len(m.messages)
	for _, want := range []perm.Mode{perm.ModeAcceptEdits, perm.ModeAuto, perm.ModePlan, perm.ModeAsk} {
		m = pressKeys(m, "shift+tab")
		if m.mode() != want {
			t.Fatalf("mode after shift+tab = %q, want %q", m.mode(), want)
		}
	}
	if len(m.messages) != messagesBefore {
		t.Errorf("cycling appended %d chat messages, want 0", len(m.messages)-messagesBefore)
	}

	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if cfg.PermissionMode != string(perm.ModeAsk) {
		t.Errorf("persisted mode = %q, want ask", cfg.PermissionMode)
	}
}

// With an overlay open, shift+tab belongs to the overlay chain and must
// never reach the mode cycler.
func TestShiftTabYieldsToOverlay(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.command("/mode accept-edits")

	m.OpenSettings(rowProvider)
	if m.settings == nil {
		t.Fatal("settings did not open")
	}
	m = pressKeys(m, "shift+tab")
	if m.mode() != perm.ModeAcceptEdits {
		t.Errorf("mode changed while settings overlay open: %q", m.mode())
	}
}

func TestModePickerSelectAndDismiss(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m.command("/mode")
	if m.modePick == nil {
		t.Fatal("bare /mode did not open the picker")
	}
	if v := m.modePickView(); !strings.Contains(v, "↑↓ select") || !strings.Contains(v, "plan") {
		t.Errorf("picker view = %q", v)
	}

	// esc dismisses without changing anything.
	m = pressKeys(m, "esc")
	if m.modePick != nil {
		t.Fatal("picker open after esc")
	}
	if m.mode() != perm.ModeAsk {
		t.Errorf("esc changed the mode to %q", m.mode())
	}

	// down walks the ladder; enter applies the highlighted mode with
	// the usual mode-change notice.
	m.command("/mode")
	m = pressKeys(m, "down") // cursor 1 (ask) → 2 (accept-edits)
	next, _ = m.Update(keyMsg("enter"))
	m = next.(Model)
	if m.modePick != nil {
		t.Error("picker open after enter")
	}
	if m.mode() != perm.ModeAcceptEdits {
		t.Errorf("mode after picker enter = %q, want accept-edits", m.mode())
	}
	if last := m.messages[len(m.messages)-1].raw; !strings.Contains(last, "mode → accept-edits") {
		t.Errorf("picker enter notice = %q", last)
	}
	cfg, err := config.Load()
	if err != nil || cfg.PermissionMode != string(perm.ModeAcceptEdits) {
		t.Errorf("persisted mode = %q (err %v), want accept-edits", cfg.PermissionMode, err)
	}

	// up from the top of the list wraps to the bottom.
	m.command("/mode plan")
	m.command("/mode")
	if m.modePick.cursor != 0 {
		t.Fatalf("picker cursor on plan = %d, want 0", m.modePick.cursor)
	}
	m = pressKeys(m, "up")
	if got := perm.Modes()[m.modePick.cursor]; got != perm.ModeAuto {
		t.Errorf("up from plan landed on %q, want auto", got)
	}
}

func TestModeHint(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	if m.modeHint() != "" {
		t.Errorf("hint shown in the default mode: %q", m.modeHint())
	}
	m.command("/mode accept-edits")
	if hint := m.modeHint(); !strings.Contains(hint, "accept-edits") || !strings.Contains(hint, "shift+tab") {
		t.Errorf("hint = %q", hint)
	}
	if m.modeHintRows() != 1 {
		t.Errorf("modeHintRows = %d, want 1", m.modeHintRows())
	}

	// The hint rides the chat view, and liveChrome accounts for it so
	// the live region stays inside the frame budget.
	if v := m.View().Content; !strings.Contains(v, "⏵⏵ accept-edits") {
		t.Errorf("chat view missing mode hint: %q", v)
	}
	if got := m.liveChrome(); got != 1+m.textarea.Height()+2+1+m.popupHeight()+m.modePickHeight()+1 {
		t.Errorf("liveChrome = %d, hint row not accounted", got)
	}
}
