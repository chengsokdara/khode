package ui

// The /agents dialog: every subagent kind the task tool can spawn — the
// built-in profiles plus user-defined ones loaded from
// ~/.khode/agents/*.md — as a read-only overview. Each row names the
// kind, badges its toolset (read-only vs full tools), and shows its
// description; the detail block lists the effective tools and where the
// kind comes from. r reloads the user files from disk.

import (
	"fmt"
	"path/filepath"
	"strings"

	"khode/internal/agent"
	"khode/internal/config"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// agentsMaxRows caps the visible kind list; further rows scroll a
// window around the cursor.
const agentsMaxRows = 10

// agentsPanel is the /agents overlay; Model.agentsPanel is non-nil
// while open. infos snapshots the catalog at open (and reload) time —
// the catalog only changes through LoadUserAgents.
type agentsPanel struct {
	infos  []agent.KindInfo
	cursor int
	warns  []string // load warnings from the last LoadUserAgents
	flash  string   // reload outcome
}

// openAgentsPanel shows the subagent kinds dialog over the chat view.
func (m *Model) openAgentsPanel() {
	m.agentsPanel = &agentsPanel{
		infos: agent.KindInfos(),
		warns: agent.UserAgentWarnings(),
	}
}

// agentsKey handles input while the dialog is open.
func (m *Model) agentsKey(msg tea.KeyMsg) tea.Cmd {
	p := m.agentsPanel
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "up", "k", "ctrl+p":
		if p.cursor > 0 {
			p.cursor--
		}
	case "down", "j", "ctrl+n":
		if p.cursor < len(p.infos)-1 {
			p.cursor++
		}
	case "r":
		p.warns = agent.LoadUserAgents(config.AgentsDir())
		p.infos = agent.KindInfos()
		p.cursor = 0
		users := 0
		for _, i := range p.infos {
			if !i.Builtin {
				users++
			}
		}
		p.flash = fmt.Sprintf("reloaded · %d user agent%s", users, plural(users))
		if len(p.warns) > 0 {
			p.flash += fmt.Sprintf(" · %d file problem%s", len(p.warns), plural(len(p.warns)))
		}
	case "esc", "q":
		m.agentsPanel = nil
	}
	return nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// agentsView renders the kind rows (name, toolset badge, description),
// a detail block for the highlighted kind, load warnings, and the key
// footer — centered in the frame like the other dialogs.
func (m *Model) agentsView() string {
	p := m.agentsPanel

	nameW := 0
	for _, i := range p.infos {
		nameW = max(nameW, lipgloss.Width(i.Name))
	}
	nameW = min(nameW, 18)

	rows := make([]string, 0, len(p.infos))
	for i, info := range p.infos {
		name := fmt.Sprintf("%-*s", nameW, clip(info.Name, nameW))
		// Both badges pad to the same lane so descriptions align.
		badge := dimStyle.Render(fmt.Sprintf("%-10s", "read-only"))
		if !info.ReadOnly {
			badge = warnStyle.Render(fmt.Sprintf("%-10s", fmt.Sprintf("%d tools", len(info.Tools))))
		}
		mark := "  "
		if i == p.cursor {
			mark = pickSel.Render("❯ ")
			name = pickSel.Render(name)
		}
		desc := clip(strings.Join(strings.Fields(info.Description), " "),
			max(8, m.width-nameW-26))
		rows = append(rows, mark+name+"  "+badge+"  "+dimStyle.Render(desc))
	}
	rows = listWindowAt(rows, p.cursor, agentsMaxRows, 2)

	var detail []string
	if len(p.infos) > 0 {
		info := p.infos[p.cursor]
		detail = append(detail, "",
			dimStyle.Render(clip("tools: "+strings.Join(info.Tools, ", "), max(10, m.width-10))))
		src := "built-in"
		if !info.Builtin {
			src = filepath.Join(config.AgentsDir(), info.Name+".md")
		}
		detail = append(detail, dimStyle.Render(clip("source: "+src, max(10, m.width-10))))
	}
	for _, w := range p.warns {
		detail = append(detail, warnStyle.Render(clip(w, max(10, m.width-10))))
	}

	body := append([]string{
		dialogTitle("agents", fmt.Sprintf("%d kinds", len(p.infos))),
		"",
		strings.Join(rows, "\n"),
	}, detail...)
	if p.flash != "" {
		body = append(body, "", flash(p.flash))
	}
	body = append(body, "",
		newHelpLine().static("↑/↓", "move").sep().
			chip("r", "reload", "r").sep().
			chip("esc", "close", "esc").String())
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, body...))
	return placeDialog(m.width, m.height, box)
}
