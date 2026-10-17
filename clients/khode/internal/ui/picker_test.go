package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"

	tea "charm.land/bubbletea/v2"
)

// Esc on a chat-opened picker goes back to the chat, however short the
// conversation is — a fresh session's one-block history must not be
// mistaken for "nothing behind the picker" (which quits).
func TestSessionsPickerEscReturnsToChat(t *testing.T) {
	m := newSettingsModel(t)
	// A usable transcript: LoadSessions skips empty files.
	line := `{"ts":"2026-09-22T00:00:00Z","role":"user","content":"hi"}`
	dir := config.SessionsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "old.jsonl"), []byte(line), 0o644); err != nil {
		t.Fatal(err)
	}
	m.command("/sessions")
	if m.picker == nil {
		t.Fatal("/sessions did not open the picker")
	}

	m = pressKeys(m, "esc")
	if m.picker != nil {
		t.Fatal("picker still open after esc")
	}
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	if v := m.View().Content; !strings.Contains(v, "nothing yet — say hello") {
		t.Errorf("chat not visible after esc: %q", v)
	}
}

// The startup picker (--resume) has no chat behind it, so esc quits;
// the chat-opened picker's esc must stay a plain close.
func TestPickerEscStartupQuitsChatCloses(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenStartupPicker([]agent.Info{{Name: "a", Path: "/tmp/a.jsonl"}})
	cmd := m.pickerKey(keyMsg("esc"))
	if cmd == nil {
		t.Fatal("startup picker esc returned no command")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatalf("startup picker esc produced %T, want QuitMsg", cmd())
	}

	c := newSettingsModel(t)
	c.OpenPicker([]agent.Info{{Name: "a", Path: "/tmp/a.jsonl"}})
	if cmd := c.pickerKey(keyMsg("esc")); cmd != nil {
		t.Fatalf("chat picker esc returned %T, want nil", cmd())
	}
	if c.picker != nil {
		t.Fatal("chat picker still open after esc")
	}
}
