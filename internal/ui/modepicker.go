package ui

import (
	"fmt"
	"strings"

	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// modePicker is the /mode chooser: a small list of modes floating above
// the input, in the manner of the command completion popup. The Model
// holds a pointer to it; nil means closed.
type modePicker struct {
	cursor int // index into perm.Modes()
}

// openModePicker shows the chooser with the cursor resting on the
// active mode.
func (m *Model) openModePicker() {
	current := m.mode()
	for i, mo := range perm.Modes() {
		if mo == current {
			m.modePick = &modePicker{cursor: i}
			return
		}
	}
	m.modePick = &modePicker{}
}

// closeModePicker hides the chooser.
func (m *Model) closeModePicker() {
	m.modePick = nil
}

// modePickKey handles input while the chooser is open, reporting done
// for keys it consumed. Everything else falls through, so ctrl+c still
// reaches the base switch.
func (m *Model) modePickKey(msg tea.KeyMsg) (cmd tea.Cmd, done bool) {
	p := m.modePick
	modes := perm.Modes()
	switch msg.String() {
	case "up", "ctrl+p":
		p.cursor = (p.cursor - 1 + len(modes)) % len(modes)
		return nil, true
	case "down", "ctrl+n":
		p.cursor = (p.cursor + 1) % len(modes)
		return nil, true
	case "enter":
		want := modes[p.cursor]
		m.closeModePicker()
		m.setMode(want)
		return m.flush(), true
	case "esc":
		m.closeModePicker()
		return nil, true
	}
	return nil, false
}

// modePickHeight is the screen rows the chooser occupies, zero when
// closed; liveChrome takes it out of the chat-block budget. Four fixed
// rows plus border and footer never grow, so no shrinking logic is
// needed beyond the footer yielding on narrow terminals.
func (m Model) modePickHeight() int {
	if m.modePick == nil {
		return 0
	}
	h := len(perm.Modes()) + 2 // rounded border
	if _, ok := m.modePickFooter(); ok {
		h++
	}
	return h
}

// modePickView renders the chooser anchored above the input box, same
// lane and border as the completion popup. The row under the cursor is
// highlighted; the active mode carries a dim mark.
func (m Model) modePickView() string {
	p := m.modePick
	modes := perm.Modes()

	innerW := max(10, m.width-4) // same lane as the textarea
	nameW := 0
	for _, mo := range modes {
		nameW = max(nameW, len(string(mo)))
	}

	lines := make([]string, 0, len(modes))
	for i, mo := range modes {
		col := fmt.Sprintf("%-*s", nameW, string(mo))
		desc := modeDescription(mo)
		if mo == m.mode() {
			desc += " (current)"
		}
		desc = clip(desc, max(8, innerW-nameW-4))
		switch {
		case i == p.cursor:
			lines = append(lines, pickSel.Render("❯ "+col)+dimStyle.Render("  "+desc))
		default:
			lines = append(lines, "  "+modeAccent(mo).Render(col)+dimStyle.Render("  "+desc))
		}
	}
	body := strings.Join(lines, "\n")
	if footer, ok := m.modePickFooter(); ok {
		body += "\n" + dimStyle.Render(footer)
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colBorder).
		Width(innerW).
		Render(body)
}

// modePickFooter renders the key cheatsheet under the rows; it yields
// when the box is too narrow to hold it on one line.
func (m Model) modePickFooter() (string, bool) {
	const footer = "↑↓ select · enter apply · esc dismiss"
	if max(10, m.width-4) < lipgloss.Width(footer)+4 {
		return "", false
	}
	return footer, true
}

// modeHint renders the permission-mode line just above the input, in
// the manner of Claude Code's mode indicator. It shows whenever the
// mode is not the default — ask is home, so it needs no reminder —
// naming the mode, what it does, and how to cycle. The status-line chip
// carries the mode in every state; this line is the shift+tab feedback.
func (m Model) modeHint() string {
	mode := m.mode()
	if mode == perm.DefaultMode {
		return ""
	}
	prefix := "⏵⏵ " + string(mode)
	tail := " · shift+tab to cycle"
	accent := modeAccent(mode).Render(prefix)
	room := m.width - lipgloss.Width(prefix) - lipgloss.Width(tail)
	switch {
	case room >= 8:
		return accent + dimStyle.Render(" · "+clip(modeDescription(mode), room)) + dimStyle.Render(tail)
	case room >= 0:
		return accent + dimStyle.Render(tail)
	default:
		return accent
	}
}

// modeHintRows is the rows modeHint occupies (one while a non-default
// mode is active) so liveBudget accounts for the line.
func (m Model) modeHintRows() int {
	if m.modeHint() == "" {
		return 0
	}
	return 1
}
