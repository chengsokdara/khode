package ui

import (
	"fmt"
	"strings"
	"time"

	"khode/internal/agent"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// picker is the session-selection overlay; non-nil while it is open.
type picker struct {
	entries []agent.Info
	cursor  int
}

// OpenPicker shows the session chooser over the chat view.
func (m *Model) OpenPicker(entries []agent.Info) {
	m.picker = &picker{entries: entries}
}

// pickerKey handles input while the picker is open. Esc closes the
// overlay when a chat is behind it and quits otherwise (startup picker).
func (m *Model) pickerKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "up", "k", "ctrl+p":
		if m.picker.cursor > 0 {
			m.picker.cursor--
		}
	case "down", "j", "ctrl+n":
		if m.picker.cursor < len(m.picker.entries)-1 {
			m.picker.cursor++
		}
	case "enter":
		return m.openPicked()
	case "esc", "q":
		if len(m.messages) > 1 {
			m.picker = nil
		} else {
			return tea.Quit
		}
	}
	return nil
}

// openPicked swaps the picked transcript in as the active session.
func (m *Model) openPicked() tea.Cmd {
	e := m.picker.entries[m.picker.cursor]
	sess, err := agent.Open(e.Path)
	m.picker = nil
	if err != nil {
		m.lastErr = err.Error()
		m.messages = append(m.messages, uiMessage{role: "system", raw: "error: " + err.Error()})
		m.renderAll()
		return nil
	}
	m.useSession(sess)
	return nil
}

func (m *Model) pickerView() string {
	rows := make([]string, 0, len(m.picker.entries))
	for i, e := range m.picker.entries {
		name := clip(e.Name, 28)
		meta := fmt.Sprintf("%d msgs · %s old", e.Messages, relTime(e.ModTime))
		if i == m.picker.cursor {
			rows = append(rows, pickSel.Render("❯ "+name)+dimStyle.Render("  "+meta))
		} else {
			rows = append(rows, "  "+name+dimStyle.Render("  "+meta))
		}
	}
	footer := keyHint("↑/↓", "move") + dimStyle.Render("  ·  ") +
		keyHint("enter", "open") + dimStyle.Render("  ·  ") +
		keyHint("esc", "cancel")
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left,
		dialogTitle("sessions", fmt.Sprintf("%d saved", len(m.picker.entries))),
		"",
		strings.Join(rows, "\n"),
		"",
		footer,
	))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// clip shortens s to n runes with an ellipsis.
func clip(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n-1]) + "…"
}

// relTime renders a coarse age: "45s", "3m", "2h", "5d".
func relTime(t time.Time) string {
	d := time.Since(t)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}
