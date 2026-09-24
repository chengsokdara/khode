package ui

// The /model dialog: a centered model chooser for the active provider,
// the one-keypath answer to "which model am I talking to". The list is
// the provider's cached choices (cfg.ModelChoices); typing filters it;
// f fetches fresh names from the endpoint via the shared fetchModelsCmd,
// whose result applyFetchedModels routes back here while the dialog is
// open. enter persists the pick with cfg.SetModel — each turn's Runner
// reads cfg.Model(), so the switch needs no live plumbing.

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// modelPick is the /model overlay; Model.modelPick is non-nil while it
// is open. list is the filtered view of all, cursor indexes list.
type modelPick struct {
	provider string   // opened for this provider; fetch results for any other are stale
	all      []string // every model name known for the provider
	filter   string   // type-to-filter, compared lowercased
	list     []string // the rows on screen: all that match filter
	cursor   int      // position in list
	fetching bool
	status   string // fetch failure note, shown under the list
}

// openModelPick opens the dialog seeded with the provider's cached
// choices, cursor on the active model. An empty cache means fetch: the
// request runs off the UI goroutine and lands in applyFetchedModels.
func (m *Model) openModelPick() tea.Cmd {
	m.modelPick = &modelPick{
		provider: m.cfg.Provider,
		all:      append([]string(nil), m.cfg.ModelChoices[m.cfg.Provider]...),
	}
	m.refreshModelPick()
	if len(m.modelPick.all) == 0 {
		m.modelPick.fetching = true
		return m.fetchModelsCmd()
	}
	return nil
}

// filterModels keeps the names containing filter as a case-insensitive
// substring; an empty filter keeps everything.
func filterModels(all []string, filter string) []string {
	filter = strings.ToLower(strings.TrimSpace(filter))
	if filter == "" {
		return append([]string(nil), all...)
	}
	out := make([]string, 0, len(all))
	for _, name := range all {
		if strings.Contains(strings.ToLower(name), filter) {
			out = append(out, name)
		}
	}
	return out
}

// refreshModelPick re-derives the visible list after the filter or the
// full list changed, keeping the cursor on the active model when it is
// still visible and at the top otherwise.
func (m *Model) refreshModelPick() {
	p := m.modelPick
	p.list = filterModels(p.all, p.filter)
	p.cursor = 0
	active := m.cfg.Model()
	for i, name := range p.list {
		if name == active {
			p.cursor = i
			break
		}
	}
}

// modelPickKey handles input while the dialog is open. Printable keys
// feed the filter (msg.Text is empty for every special key), so j/k
// spell here instead of navigating — arrows and ctrl+p/n move the
// cursor, the one deviation from the other pickers.
func (m *Model) modelPickKey(msg tea.KeyPressMsg) tea.Cmd {
	p := m.modelPick
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "up", "ctrl+p":
		if p.cursor > 0 {
			p.cursor--
		}
	case "down", "ctrl+n":
		if p.cursor < len(p.list)-1 {
			p.cursor++
		}
	case "enter":
		if len(p.list) == 0 {
			return nil
		}
		name := p.list[p.cursor]
		m.cfg.SetModel(name)
		if err := m.cfg.Save(); err != nil {
			m.lastErr = err.Error()
		}
		m.modelPick = nil
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("model → %s/%s", m.provider.Name(), m.cfg.Model())})
		return m.flush()
	case "esc":
		m.modelPick = nil
		return nil
	case "f":
		if !p.fetching {
			p.fetching = true
			p.status = ""
			return m.fetchModelsCmd()
		}
	case "backspace", "ctrl+h":
		if r := []rune(p.filter); len(r) > 0 {
			p.filter = string(r[:len(r)-1])
			m.refreshModelPick()
		}
		return nil
	}
	if msg.Text != "" {
		p.filter += msg.Text
		m.refreshModelPick()
	}
	return nil
}

// modelPickView renders the dialog: title, filter row, the visible
// slice of the list with the active model dotted, fetch state, key
// footer — centered in the frame like the other dialogs.
func (m *Model) modelPickView() string {
	p := m.modelPick

	sub := fmt.Sprintf("%s · %d models", m.provider.Name(), len(p.all))
	if p.filter != "" {
		sub = fmt.Sprintf("%s · %d/%d", m.provider.Name(), len(p.list), len(p.all))
	}

	filterRow := pickSel.Render("❯ ") + dimStyle.Render("type to filter…")
	if p.filter != "" {
		filterRow = pickSel.Render("❯ ") + p.filter + "▌"
	}

	active := m.cfg.Model()
	rows := make([]string, 0, len(p.list))
	for i, name := range p.list {
		cur, dot := "  ", "  "
		if i == p.cursor {
			cur = pickSel.Render("❯ ")
			name = pickSel.Render(name)
		}
		if p.list[i] == active {
			dot = okStyle.Render("● ")
		}
		rows = append(rows, cur+dot+name)
	}
	rows = listWindowAt(rows, p.cursor, listMaxRows(m.height), 4)

	body := []string{
		dialogTitle("model", sub),
		"",
		filterRow,
		"",
	}
	switch {
	case len(rows) > 0:
		body = append(body, strings.Join(rows, "\n"))
	case p.status != "":
		body = append(body, dimStyle.Render(p.status))
	default:
		body = append(body, dimStyle.Render("no models known · f fetch"))
	}
	if p.fetching {
		body = append(body, "", m.spinner.View()+statusStyle.Render(" fetching models…"))
	} else if p.status != "" && len(rows) > 0 {
		body = append(body, "", dimStyle.Render(p.status))
	}
	body = append(body, "",
		newHelpLine().static("↑/↓", "move").sep().
			chip("enter", "use", "enter").sep().
			chip("f", "fetch", "f").sep().
			chip("esc", "close", "esc").sep().note("type to filter").String())

	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, body...))
	return placeDialog(m.width, m.height, box)
}
