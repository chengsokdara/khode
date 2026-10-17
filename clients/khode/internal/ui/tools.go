package ui

import (
	"fmt"
	"strings"

	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// toolsMaxRows caps the visible list; further rows scroll a window
// around the cursor.
const toolsMaxRows = 12

// toolsPanel is the /tools overlay: every registered tool with its risk
// class, each toggleable for this session. Non-nil while it is open.
type toolsPanel struct {
	names  []string // registry names, name order; snapshot from open time
	cursor int
}

// openTools shows the tool panel over the chat view.
func (m *Model) openTools() {
	m.toolsPanel = &toolsPanel{names: m.tools.Names()}
}

// toolsKey handles input while the panel is open. Enter toggles the
// tool under the cursor; esc closes back to the chat.
func (m *Model) toolsKey(msg tea.KeyMsg) tea.Cmd {
	p := m.toolsPanel
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "up", "k", "ctrl+p":
		if p.cursor > 0 {
			p.cursor--
		}
	case "down", "j", "ctrl+n":
		if p.cursor < len(p.names)-1 {
			p.cursor++
		}
	case "enter", "space":
		if len(p.names) > 0 {
			name := p.names[p.cursor]
			m.tools.SetEnabled(name, !m.tools.Enabled(name))
		}
	case "esc", "q":
		m.toolsPanel = nil
	}
	return nil
}

// riskStyle picks a badge color per risk class: the more a tool can
// touch, the louder the badge.
func riskStyle(r perm.Risk) lipgloss.Style {
	switch r {
	case perm.RiskWrite:
		return warnStyle
	case perm.RiskExec:
		return errorStyle
	}
	return dimStyle
}

func (m *Model) toolsView() string {
	p := m.toolsPanel

	// The name column spans the widest tool so descriptions keep their
	// lane even with long mcp__server__tool names in the list.
	nameW := 0
	disabled := 0
	for _, n := range p.names {
		nameW = max(nameW, lipgloss.Width(n))
		if !m.tools.Enabled(n) {
			disabled++
		}
	}
	nameW = min(nameW, 24)

	var rows []string
	if len(p.names) == 0 {
		rows = append(rows, dimStyle.Render("no tools registered"))
	}
	start := 0
	if len(p.names) > toolsMaxRows {
		start = min(max(0, p.cursor-toolsMaxRows/2), len(p.names)-toolsMaxRows)
	}
	end := start + min(toolsMaxRows, len(p.names))
	// Content rows: title and its blank lead, then the list.
	rowAt := 2
	for j, n := range p.names[start:end] {
		i := start + j
		stage(relRegion{row: rowAt, kind: clickToggle, idx: i})
		rowAt++
		// Descriptions are single-line summaries here: collapse the
		// whitespace (several tools and MCP servers use multi-line
		// text) so one row stays one row.
		desc := ""
		if t, ok := m.tools.Get(n); ok {
			desc = clip(strings.Join(strings.Fields(t.Description()), " "), max(8, m.width-nameW-18))
		}
		risk := m.tools.RiskOf(n)
		state := okStyle.Render("✓")
		name := toolStyle.Render(fmt.Sprintf("%-*s", nameW, clip(n, nameW)))
		badge := riskStyle(risk).Render(fmt.Sprintf("%-5s", string(risk)))
		if !m.tools.Enabled(n) {
			// Disabled reads as struck out; only the state marker and
			// the badge dim instead of changing hue.
			state = dimStyle.Render("✗")
			name = dimStyle.Strikethrough(true).Render(fmt.Sprintf("%-*s", nameW, clip(n, nameW)))
			badge = dimStyle.Render(fmt.Sprintf("%-5s", string(risk)))
		}
		mark := "  "
		if i == p.cursor {
			mark = pickSel.Render("❯ ")
		}
		rows = append(rows, mark+state+" "+name+" "+badge+dimStyle.Render(" "+desc))
	}
	if len(p.names) > toolsMaxRows {
		rows = append(rows, dimStyle.Render(fmt.Sprintf("  %d/%d · ↑/↓ more", p.cursor+1, len(p.names))))
		stage(relRegion{row: rowAt, kind: clickMoreDown, idx: toolsMaxRows})
	}

	footer := newHelpLine().static("↑/↓", "move").sep().
		chip("enter", "toggle", "enter").sep().chip("esc", "close", "esc")
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left,
		dialogTitle("tools", fmt.Sprintf("%d/%d off", disabled, len(p.names))),
		"",
		strings.Join(rows, "\n"),
		"",
		footer.String(),
	))
	return placeDialog(m.width, m.height, box)
}
