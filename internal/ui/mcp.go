package ui

// The /mcp dialog: every configured MCP server with its live status —
// running (client in mcpClients), registered tool count, risk class —
// plus three live actions. enter starts or restarts the highlighted
// server through the shared applyMCPCmd reconcile (the same machinery
// /settings triggers on edits); space toggles all of the server's tools
// for this session, the /tools semantics in bulk per server; n opens
// the add form, the same fields/settings machinery the settings MCP
// row uses, hosted right in the dialog.

import (
	"fmt"
	"sort"
	"strings"

	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// mcpMaxRows caps the visible server list; further rows scroll a
// window around the cursor.
const mcpMaxRows = 10

// mcpPanel is the /mcp overlay; Model.mcpPanel is non-nil while open.
// names snapshots the configured servers at open time and is refreshed
// after an add; running state, tool counts, and toggles render from
// live state every frame, so the view can never go stale.
type mcpPanel struct {
	names  []string
	cursor int
	busy   map[string]bool // servers with a reconcile in flight
	form   *serverForm     // add-server form; nil when closed
	flash  string          // form validation / save outcome
}

// openMCPPanel shows the MCP servers dialog over the chat view.
func (m *Model) openMCPPanel() {
	names := make([]string, 0, len(m.cfg.MCPServers))
	for n := range m.cfg.MCPServers {
		names = append(names, n)
	}
	sort.Strings(names)
	m.mcpPanel = &mcpPanel{names: names}
}

// serverTools lists the registry names of one server's registered
// tools; an empty result means it never came up (or advertises none).
func serverTools(regNames []string, server string) []string {
	prefix := "mcp__" + server + "__"
	var out []string
	for _, n := range regNames {
		if strings.HasPrefix(n, prefix) {
			out = append(out, n)
		}
	}
	return out
}

// mcpPanelKey handles input while the dialog is open. While the add
// form is up, it owns every key.
func (m *Model) mcpPanelKey(msg tea.KeyMsg) tea.Cmd {
	p := m.mcpPanel
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	}
	if p.form != nil {
		cmd, flash, closed := m.formKey(msg, p.form)
		p.flash = flash
		if closed {
			// A successful save lands the cursor on the saved server;
			// a failed one keeps the form up for fixing.
			if flash != "" && !strings.HasPrefix(flash, "✗") {
				p.names = sortedServerNames(m.cfg.MCPServers)
				saved := strings.TrimSpace(p.form.inputs[0].Value())
				for i, n := range p.names {
					if n == saved {
						p.cursor = i
						break
					}
				}
			}
			p.form = nil
		}
		return cmd
	}
	switch msg.String() {
	case "up", "k", "ctrl+p":
		if p.cursor > 0 {
			p.cursor--
		}
	case "down", "j", "ctrl+n":
		if p.cursor < len(p.names)-1 {
			p.cursor++
		}
	case "n":
		p.form = m.newMCPServerForm("")
		p.form.focus()
		p.flash = ""
		return nil
	case "enter", "r":
		if len(p.names) == 0 || p.busy[p.names[p.cursor]] {
			return nil // nothing to do / a reconcile is already in flight
		}
		name := p.names[p.cursor]
		if p.busy == nil {
			p.busy = map[string]bool{}
		}
		p.busy[name] = true
		return m.applyMCPCmd([]string{name})
	case "space":
		if len(p.names) == 0 {
			return nil
		}
		tools := serverTools(m.tools.Names(), p.names[p.cursor])
		if len(tools) == 0 {
			return nil
		}
		all := true
		for _, tn := range tools {
			if !m.tools.Enabled(tn) {
				all = false
				break
			}
		}
		// All on → all off; anything off → all on.
		for _, tn := range tools {
			m.tools.SetEnabled(tn, !all)
		}
	case "esc", "q":
		m.mcpPanel = nil
	}
	return nil
}

// mcpPanelView renders the server rows (status glyph, tool summary,
// risk badge), a detail block for the highlighted server, and the key
// footer — centered in the frame like the other dialogs. While the add
// form is up, the form takes the frame.
func (m *Model) mcpPanelView() string {
	p := m.mcpPanel
	if p.form != nil {
		return m.mcpFormView()
	}
	regNames := m.tools.Names()

	nameW := 0
	for _, n := range p.names {
		nameW = max(nameW, lipgloss.Width(n))
	}
	nameW = min(nameW, 20)

	var rows []string
	if len(p.names) == 0 {
		rows = append(rows, dimStyle.Render("no MCP servers yet · n add one"))
	}
	for i, n := range p.names {
		_, running := m.mcpClients[n]
		tools := serverTools(regNames, n)
		off := 0
		for _, tn := range tools {
			if !m.tools.Enabled(tn) {
				off++
			}
		}

		var glyph string
		switch {
		case p.busy[n]:
			glyph = m.spinner.View()
		case running:
			glyph = okStyle.Render("● ")
		default:
			glyph = dimStyle.Render("○ ")
		}
		summary := dimStyle.Render("unavailable")
		if running {
			summary = fmt.Sprintf("%d tools", len(tools))
			if off > 0 {
				summary += dimStyle.Render(fmt.Sprintf(" (%d off)", off))
			}
		}

		sc := m.cfg.MCPServers[n]
		risk := sc.Risk
		if risk == "" {
			risk = string(perm.RiskExec)
		}
		badge := riskStyle(perm.Risk(risk)).Render(fmt.Sprintf("%-5s", risk))

		name := fmt.Sprintf("%-*s", nameW, clip(n, nameW))
		mark := "  "
		if i == p.cursor {
			mark = pickSel.Render("❯ ")
			name = pickSel.Render(name)
		}
		rows = append(rows, mark+glyph+" "+name+"  "+summary+"  "+badge)
	}
	rows = listWindow(rows, p.cursor, mcpMaxRows)

	// Detail block: the highlighted server's launch line and, when it
	// is up, its tool names — the readable part of the old /mcp text.
	var detail []string
	if len(p.names) > 0 {
		n := p.names[p.cursor]
		if sc, ok := m.cfg.MCPServers[n]; ok {
			cmdline := strings.Join(append([]string{sc.Command}, sc.Args...), " ")
			detail = append(detail, "", dimStyle.Render(clip(cmdline, max(10, m.width-10))))
			if _, running := m.mcpClients[n]; running {
				prefix := "mcp__" + n + "__"
				var shorts []string
				for _, tn := range serverTools(regNames, n) {
					shorts = append(shorts, strings.TrimPrefix(tn, prefix))
				}
				detail = append(detail, dimStyle.Render(clip("tools: "+strings.Join(shorts, ", "), max(10, m.width-10))))
			} else {
				detail = append(detail, dimStyle.Render("unavailable · enter to start · edit in /settings"))
			}
		}
	}

	footer := keyHint("↑/↓", "move") + dimStyle.Render("  ·  ") +
		keyHint("n", "add") + dimStyle.Render("  ·  ")
	if len(p.names) > 0 {
		footer += keyHint("enter", "restart") + dimStyle.Render("  ·  ") +
			keyHint("space", "tools") + dimStyle.Render("  ·  ")
	}
	footer += keyHint("esc", "close")

	body := append([]string{
		dialogTitle("mcp", fmt.Sprintf("%d servers", len(p.names))),
		"",
		strings.Join(rows, "\n"),
	}, detail...)
	if p.flash != "" {
		body = append(body, "", flash(p.flash))
	}
	body = append(body, "", footer)
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, body...))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// mcpFormView renders the add-server form inside the dialog frame: the
// shared form rows, the outcome flash, and the form key footer.
func (m *Model) mcpFormView() string {
	p := m.mcpPanel
	body := []string{
		dialogTitle("mcp", "add server"),
		"",
		strings.Join(serverFormView(p.form), "\n"),
	}
	if p.flash != "" {
		body = append(body, "", flash(p.flash))
	}
	body = append(body, "",
		keyHint("↑/↓", "move")+dimStyle.Render("  ·  ")+
			keyHint("tab", "next")+dimStyle.Render("  ·  ")+
			keyHint("←/→", "cycle")+dimStyle.Render("  ·  ")+
			keyHint("enter", "save")+dimStyle.Render("  ·  ")+
			keyHint("esc", "cancel"))
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, body...))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}
