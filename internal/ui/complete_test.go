package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
)

// matchNames renders the popup's current matches for assertions.
func matchNames(m Model) []string {
	var out []string
	for _, i := range m.popup.matches {
		out = append(out, slashCommands[i].name)
	}
	return out
}

func TestPopupOpensOnSlashAndFilters(t *testing.T) {
	m := pressKeys(newTestModel(t), "/")
	if m.popup == nil {
		t.Fatal("typing / did not open the popup")
	}
	if len(m.popup.matches) != len(slashCommands) {
		t.Errorf("/ matched %d commands, want all %d", len(m.popup.matches), len(slashCommands))
	}

	m = pressKeys(m, "m", "o")
	if got := strings.Join(matchNames(m), ","); got != "model,mode" {
		t.Errorf("/mo matches = %q, want model,mode", got)
	}

	m = pressKeys(m, "d", "e")
	if got := slashCommands[m.popup.matches[0]].name; got != "mode" {
		t.Errorf("exact /mode highlighted %q, want mode first over model", got)
	}

	m = pressKeys(m, "backspace", "backspace", "backspace", "backspace", "H", "E")
	if got := strings.Join(matchNames(m), ","); got != "help" {
		t.Errorf("/HE matches = %q, want help (case-insensitive)", got)
	}
}

func TestPopupClosesOnSpacePlainAndUnknown(t *testing.T) {
	m := pressKeys(newTestModel(t), "/", " ")
	if m.popup != nil {
		t.Error("space after the command word did not close the popup")
	}

	m = pressKeys(m, "h", "i")
	if m.popup != nil {
		t.Error("plain text opened the popup")
	}

	// Fresh input: "/zz" has no candidate, backspacing into a known
	// command reopens, deleting the / closes again.
	m = pressKeys(newTestModel(t), "/", "z", "z")
	if m.popup != nil {
		t.Error("unknown command kept the popup open")
	}
	m = pressKeys(m, "backspace")
	if m.popup != nil {
		t.Error("backspace into a still-unknown command opened the popup")
	}
	m = pressKeys(m, "backspace")
	if m.popup == nil {
		t.Error("backspace into a known command did not reopen the popup")
	}
	m = pressKeys(m, "backspace")
	if m.popup != nil {
		t.Error("deleting the / did not close the popup")
	}
}

func TestPopupNavigationWrapsAndEscDismisses(t *testing.T) {
	m := pressKeys(newTestModel(t), "/")
	n := len(m.popup.matches)

	m = pressKeys(m, "down")
	if m.popup.cursor != 1 {
		t.Errorf("cursor after down = %d, want 1", m.popup.cursor)
	}
	m = pressKeys(m, "up", "up")
	if m.popup.cursor != n-1 {
		t.Errorf("cursor did not wrap up: got %d, want %d", m.popup.cursor, n-1)
	}
	m = pressKeys(m, "down")
	if m.popup.cursor != 0 {
		t.Errorf("cursor did not wrap down: got %d, want 0", m.popup.cursor)
	}

	m = pressKeys(m, "esc")
	if m.popup != nil {
		t.Error("esc did not close the popup")
	}
	if m.textarea.Value() != "/" {
		t.Errorf("esc kept text = %q, want the typed / intact", m.textarea.Value())
	}
}

func TestTabFillsWithoutRunning(t *testing.T) {
	m := pressKeys(newTestModel(t), "/", "c", "o", "m", "tab")
	if m.popup != nil {
		t.Error("tab did not close the popup")
	}
	if got := m.textarea.Value(); got != "/compact " {
		t.Errorf("tab filled %q, want /compact with a trailing space", got)
	}
	if len(m.messages) != 1 { // only the startup banner
		t.Errorf("tab ran the command: %d messages", len(m.messages))
	}
}

func TestEnterRunsArglessCommand(t *testing.T) {
	m := pressKeys(newTestModel(t), "/", "h", "e")
	if got := slashCommands[m.popup.matches[0]].name; got != "help" {
		t.Fatalf("/he highlighted %q, want help", got)
	}
	m = pressKeys(m, "enter")
	if m.popup != nil {
		t.Error("enter did not close the popup")
	}
	if m.textarea.Value() != "" {
		t.Errorf("textarea = %q after running help, want empty", m.textarea.Value())
	}
	if len(m.messages) != 2 {
		t.Fatalf("help appended %d messages, want banner + help", len(m.messages))
	}
	raw := m.messages[len(m.messages)-1].raw
	for _, c := range slashCommands {
		if !strings.Contains(raw, "/"+c.name) {
			t.Errorf("help output missing /%s — it must list the whole table", c.name)
		}
	}
}

func TestEnterFillsCommandWithArgs(t *testing.T) {
	m := pressKeys(newTestModel(t), "/", "m", "o", "d", "e", "enter")
	if m.popup != nil {
		t.Error("enter did not close the popup")
	}
	if got := m.textarea.Value(); got != "/mode " {
		t.Errorf("enter filled %q, want /mode ready for its argument", got)
	}
	for _, msg := range m.messages[1:] {
		if strings.Contains(msg.raw, "usage: /mode") {
			t.Error("enter ran /mode instead of filling it")
		}
	}
}

func TestEnterFillsOnlyWhileStreaming(t *testing.T) {
	m := newTestModel(t)
	m.streaming = true // a turn is in flight; nothing may submit

	m = pressKeys(m, "/", "h", "e", "enter")
	if got := m.textarea.Value(); got != "/help " {
		t.Errorf("mid-stream enter filled %q, want /help without running", got)
	}
	if len(m.messages) != 1 {
		t.Errorf("mid-stream enter ran the command: %d messages", len(m.messages))
	}
}

func TestAliasCompletesAndRuns(t *testing.T) {
	m := pressKeys(newTestModel(t), "/", "c", "o", "n")
	if got := strings.Join(matchNames(m), ","); got != "config" {
		t.Errorf("/con matches = %q, want config only", got)
	}
	m = pressKeys(m, "enter")
	if m.settings == nil {
		t.Error("enter on the /config alias did not open settings")
	}
	if m.textarea.Value() != "" {
		t.Errorf("textarea = %q after running the alias, want empty", m.textarea.Value())
	}
}

func TestPopupShrinksLiveBudget(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	if m.popupHeight() != 0 {
		t.Fatalf("hidden popup occupies %d rows", m.popupHeight())
	}
	before := m.liveBudget()
	if before <= 0 {
		t.Fatalf("baseline live budget = %d", before)
	}

	m = pressKeys(m, "/")
	if m.popupHeight() == 0 {
		t.Fatal("popup did not open")
	}
	if got := m.liveBudget(); got >= before {
		t.Errorf("live budget with popup = %d, want < %d (popup rows carved out)", got, before)
	}

	m = pressKeys(m, "esc")
	if m.popupHeight() != 0 {
		t.Fatal("popup still open after esc")
	}
	if got := m.liveBudget(); got != before {
		t.Errorf("live budget after esc = %d, want the original %d", got, before)
	}
}

func TestPopupViewRendersAboveInput(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m = pressKeys(m, "/", "t", "o")

	out := m.View().Content
	if !strings.Contains(out, "/tools") {
		t.Error("popup view does not show the matched command")
	}
	if !strings.Contains(out, "esc dismiss") {
		t.Error("popup view is missing the key cheatsheet")
	}
	// The popup renders between the status line and the input box: its
	// cheatsheet must sit above the bottom help line ("esc stop
	// stream"), which always renders last.
	if strings.Index(out, "esc dismiss") > strings.Index(out, "stop stream") {
		t.Error("popup rendered below the input box")
	}
}
