package ui

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// slashCommand is one entry of the command table. args is the usage
// hint ("[name]", "<name>") and empty when the command takes none.
type slashCommand struct {
	name string
	args string
	desc string
}

// slashCommands is the single source of truth for the command surface:
// the completion popup filters it and /help renders it, in this order.
// Aliases are ordinary rows so they complete and document themselves.
var slashCommands = []slashCommand{
	{"help", "", "this command list"},
	{"new", "[name]", "fresh session, optionally named"},
	{"sessions", "", "switch session (picker)"},
	{"settings", "", "configure keys, provider, model, MCP, hooks"},
	{"config", "", "alias of /settings"},
	{"model", "<name>", "switch model (persisted)"},
	{"mode", "[name]", "permission mode picker · shift+tab cycles"},
	{"compact", "", "summarize older turns to shrink the context"},
	{"tools", "", "browse and toggle tools the model can call"},
	{"mcp", "", "MCP server status"},
	{"exit", "", "leave khode"},
	{"quit", "", "alias of /exit"},
}

// helpText renders the command table for /help.
func helpText() string {
	lines := make([]string, 0, len(slashCommands))
	for _, c := range slashCommands {
		name := "/" + c.name
		if c.args != "" {
			name += " " + c.args
		}
		lines = append(lines, fmt.Sprintf("%-14s %s", name, c.desc))
	}
	return strings.Join(lines, "\n")
}

// maxPopupRows caps the completion list; further matches scroll a
// window around the cursor.
const maxPopupRows = 8

// cmdPopup is the slash-command completion state. The Model holds a
// pointer to it; nil means hidden.
type cmdPopup struct {
	query   string // lowercased command word being typed, without the slash
	matches []int  // indices into slashCommands
	cursor  int
}

// completionQuery reports the command word being typed: ok is true
// while the input is a bare "/word" — once a space or newline joins,
// the user is past the command and into its arguments.
func completionQuery(value string) (query string, ok bool) {
	if !strings.HasPrefix(value, "/") || strings.ContainsAny(value, " \t\n") {
		return "", false
	}
	return strings.ToLower(value[1:]), true
}

// matchCommands returns the table indices whose name starts with the
// already-lowercased query, exact matches promoted to the front so
// typing a full command highlights it rather than a longer sibling.
func matchCommands(query string) []int {
	var matches []int
	for i, c := range slashCommands {
		if !strings.HasPrefix(c.name, query) {
			continue
		}
		if c.name == query {
			matches = append([]int{i}, matches...)
		} else {
			matches = append(matches, i)
		}
	}
	return matches
}

// syncPopup re-derives the completion list from the current input. It
// runs after every keystroke that reaches the textarea.
func (m *Model) syncPopup() {
	query, ok := completionQuery(m.textarea.Value())
	if !ok {
		m.closePopup()
		return
	}
	matches := matchCommands(query)
	if len(matches) == 0 {
		// No candidate: let submit report the unknown command.
		m.closePopup()
		return
	}
	if m.popup != nil && m.popup.query == query {
		return // the list did not change; keep the cursor
	}
	m.popup = &cmdPopup{query: query, matches: matches}
}

// closePopup hides the completion list; its rows go back to the live
// budget automatically (popupHeight feeds it per render).
func (m *Model) closePopup() {
	if m.popup == nil {
		return
	}
	m.popup = nil
}

// popupKey handles input while the popup is open, reporting done for
// keys it consumed. Everything else falls through to the textarea —
// letters especially, since the user is typing the query — and
// syncPopup refilters afterwards.
func (m *Model) popupKey(msg tea.KeyMsg) (cmd tea.Cmd, done bool) {
	p := m.popup
	switch msg.String() {
	case "up", "ctrl+p":
		p.cursor = (p.cursor - 1 + len(p.matches)) % len(p.matches)
		return nil, true
	case "down", "ctrl+n":
		p.cursor = (p.cursor + 1) % len(p.matches)
		return nil, true
	case "tab":
		m.fillCommand(p.highlighted().name)
		return nil, true
	case "enter":
		return m.acceptCommand(), true
	case "esc":
		m.closePopup()
		return nil, true
	}
	return nil, false
}

// highlighted returns the command under the cursor.
func (p *cmdPopup) highlighted() slashCommand {
	return slashCommands[p.matches[p.cursor]]
}

// fillCommand swaps the typed word for name, leaving a trailing space
// so argument typing can start right away.
func (m *Model) fillCommand(name string) {
	m.closePopup()
	m.textarea.SetValue("/" + name + " ")
}

// acceptCommand answers enter: argument-free commands run at once
// (except mid-stream, where nothing submits), the rest fill the input
// so their arguments can be typed.
func (m *Model) acceptCommand() tea.Cmd {
	c := m.popup.highlighted()
	m.fillCommand(c.name)
	if c.args == "" && !m.streaming {
		return m.submit()
	}
	return nil
}

// popupView renders the completion list anchored above the input box,
// matching its width so the two read as one unit.
func (m *Model) popupView() string {
	p := m.popup
	// The visible row count follows the clamped box height so the view
	// and the budget accounting can never drift apart.
	footerH := 0
	if _, ok := m.popupFooter(); ok {
		footerH = 1
	}
	rows := m.popupHeight() - 2 - footerH
	from := max(0, min(p.cursor-rows+1, len(p.matches)-rows))

	// The command column spans the widest entry of the whole table so
	// rows keep their lane while the filter narrows.
	nameW := 0
	for _, c := range slashCommands {
		w := 1 + len(c.name)
		if c.args != "" {
			w += 1 + len(c.args)
		}
		nameW = max(nameW, w)
	}

	innerW := max(10, m.width-4) // same lane as the textarea
	lines := make([]string, 0, rows+1)
	for i := from; i < from+rows; i++ {
		c := slashCommands[p.matches[i]]
		col := "/" + c.name
		if c.args != "" {
			col += " " + c.args
		}
		col = fmt.Sprintf("%-*s", nameW, col)
		desc := clip(c.desc, max(8, innerW-nameW-4))
		if i == p.cursor {
			lines = append(lines, pickSel.Render("❯ "+col)+dimStyle.Render("  "+desc))
		} else {
			lines = append(lines, "  "+cmdStyle.Render(col)+dimStyle.Render("  "+desc))
		}
	}
	body := strings.Join(lines, "\n")
	if footer, ok := m.popupFooter(); ok {
		body += "\n" + footer
	}
	return lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder()).
		BorderForeground(colBorder).
		Width(innerW).
		Render(body)
}

// popupFooter renders the key cheatsheet under the rows; it yields
// when the box is too narrow to hold it on one line.
func (m *Model) popupFooter() (string, bool) {
	const footer = "↑↓ select · enter run · tab fill · esc dismiss"
	if max(10, m.width-4) < lipgloss.Width(footer)+4 {
		return "", false
	}
	return dimStyle.Render(footer), true
}

// popupHeight is the screen rows the popup occupies, zero when hidden;
// liveChrome takes it out of the chat-block budget. On short terminals
// the list yields rows so the live region stays inside the frame cap
// (see liveBudget) instead of being clipped by the renderer.
func (m *Model) popupHeight() int {
	if m.popup == nil {
		return 0
	}
	h := min(maxPopupRows, len(m.popup.matches)) + 2 // rounded border
	if _, ok := m.popupFooter(); ok {
		h++
	}
	if room := m.height - 2 - (1 + m.textarea.Height() + 2 + 1) - 1; h > room && room > 0 {
		h = room
	}
	return h
}
