package ui

// click.go — mouse click targets. Every button, list row, and chip the
// TUI draws registers a screen-space region while rendering (the same
// render-time geometry the approval dialog's scrollbar has always
// recorded), and the click dispatcher hit-tests a press against those
// regions. Only the surface that rendered last has regions, so the
// registry always matches what is on screen; the UI runs on one
// goroutine, so no locking.

import (
	"fmt"
	"strings"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// clickKind says what a region does when pressed.
type clickKind uint8

const (
	clickNone      clickKind = iota // rendered like a chip but inert (compound hints such as "↑/↓")
	clickKey                        // a footer keycap chip: presses its key
	clickRow                        // a list row (idx): select it; selecting the row under the cursor activates it
	clickToggle                     // a /tools checkbox row (idx): toggles at once
	clickFormField                  // a form's text row (idx): focus that field
	clickFormEnum                   // a form's enum row: step the value
	clickFormSave                   // a form's save row: commit
	clickOpenURL                    // the sign-in dialog's verification URL: open the browser
	clickModeChip                   // the header/status mode chip: cycle the permission mode
	clickHintCmd                    // a slash command named in the setup banner (idx): run it
	clickMoreUp                     // a list window's "↑ N more" note: page the cursor up
	clickMoreDown                   // a list window's "↓ N more" note: page the cursor down
)

// Setup-banner commands, as clickHintCmd's idx.
const (
	hintWelcome = iota
	hintLogin
	hintSettings
)

// region is one click target in screen coordinates; h is always one
// row. key carries the synthesized key for clickKey regions.
type region struct {
	x, y, w int
	kind    clickKind
	idx     int
	key     tea.KeyPressMsg
}

// relRegion is a region in dialog-content coordinates: x is the column
// within the content area and row the content row (0 = first row under
// the box's top border and padding). w == 0 means "to the right edge".
// row < 0 marks the box's last content row — the footer line — which is
// only known once the box has been built.
type relRegion struct {
	x, row, w int
	kind      clickKind
	idx       int
	key       tea.KeyPressMsg
}

// rowFooter asks the flush to pin a region to the box's footer row.
const rowFooter = -1

// The registry plus the dialog geometry the flush maps through. All
// written during View on the UI goroutine.
var (
	regions []region // this frame's click targets
	pending []relRegion

	dlgX, dlgY int // the centered box's top-left corner
	dlgW       int // terminal width, for full-width rows
)

// resetRegions empties the registry for a fresh frame.
func resetRegions() {
	regions = regions[:0]
	pending = pending[:0]
}

// stage records a content-relative region; placeDialog's flush turns
// staged regions into screen coordinates.
func stage(rr relRegion) {
	pending = append(pending, rr)
}

// placeDialog centers box in the frame the way the overlay views do,
// records where its content area landed, and resolves everything staged
// for the box into screen regions. Content starts two rows into the box
// (border, padding) and three columns in; its last row is the footer.
func placeDialog(width, height int, box string) string {
	dlgX = max(0, (width-lipgloss.Width(box))/2)
	dlgY = max(0, (height-lipgloss.Height(box))/2)
	dlgW = width
	footerRow := lipgloss.Height(box) - 5
	for _, rr := range pending {
		row := rr.row
		if row == rowFooter {
			row = footerRow
		}
		x := dlgX + 3 + rr.x
		w := rr.w
		if w == 0 {
			w = max(1, dlgW-x)
		}
		regions = append(regions, region{
			x: x, y: dlgY + 2 + row, w: w,
			kind: rr.kind, idx: rr.idx, key: rr.key,
		})
	}
	pending = pending[:0]
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, box)
}

// addRegion registers an already-absolute region. The chat frame's
// inline surfaces — completion popup, mode picker, banner, chips —
// record directly, since they are not centered boxes.
func addRegion(r region) {
	regions = append(regions, r)
}

// regionAt returns the region covering the pressed cell, topmost drawn
// first.
func regionAt(x, y int) (region, bool) {
	for i := len(regions) - 1; i >= 0; i-- {
		r := regions[i]
		if x >= r.x && x < r.x+r.w && y >= r.y && y < r.y+1 {
			return r, true
		}
	}
	return region{}, false
}

// keyPress synthesizes the keypress a footer chip stands for. Chip
// labels stay keyboard-truthful ("n/esc") while the press carries the
// fragment's primary action ("n").
func keyPress(name string) tea.KeyPressMsg {
	switch name {
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}
	case "shift+tab":
		return tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	case "space":
		return tea.KeyPressMsg{Code: tea.KeySpace, Text: " "}
	}
	r := []rune(name)
	if len(r) == 1 {
		return tea.KeyPressMsg{Code: r[0], Text: name}
	}
	return tea.KeyPressMsg{}
}

// helpLine assembles a dialog footer row from fragments, staging every
// keycap chip as a clickKey region pinned to the box's footer row.
// Chips without a single key behind them ("↑/↓ move") go through static
// and stay inert.
type helpLine struct {
	parts []string
	x     int
}

func newHelpLine() *helpLine { return &helpLine{} }

// chip appends a keycap chip that presses press when clicked.
func (h *helpLine) chip(label, verb, press string) *helpLine {
	h.append(label, verb, clickKey, 0, keyPress(press))
	return h
}

// static appends a keycap-look chip with no click action.
func (h *helpLine) static(label, verb string) *helpLine {
	h.append(label, verb, clickNone, 0, tea.KeyPressMsg{})
	return h
}

// note appends plain dim text.
func (h *helpLine) note(s string) *helpLine {
	h.parts = append(h.parts, dimStyle.Render(s))
	h.x += lipgloss.Width(s)
	return h
}

// sep joins fragments with the quiet middle-dot separator.
func (h *helpLine) sep() *helpLine {
	s := dimStyle.Render("  ·  ")
	h.parts = append(h.parts, s)
	h.x += lipgloss.Width(s)
	return h
}

func (h *helpLine) append(label, verb string, kind clickKind, idx int, key tea.KeyPressMsg) {
	rendered := keycapStyle.Render(label)
	stage(relRegion{
		x: h.x, row: rowFooter, w: lipgloss.Width(rendered),
		kind: kind, idx: idx, key: key,
	})
	h.parts = append(h.parts, rendered+dimStyle.Render(" "+verb))
	h.x += lipgloss.Width(rendered) + 1 + lipgloss.Width(verb)
}

// String renders the assembled line.
func (h *helpLine) String() string {
	return strings.Join(h.parts, "")
}

// listWindowAt slices a rendered dialog list to maxRows around the
// cursor — the window listWindow draws — and stages click regions for
// what it draws: one full-width row per visible entry (idx = the
// entry's index in rows) plus the ↑/↓ count notes, which page the
// window. boxRow is the content row the first drawn line will occupy.
// Lists that fit pass through whole, still clickable.
func listWindowAt(rows []string, cursor, maxRows, boxRow int) []string {
	start, windowed := 0, false
	if len(rows) > maxRows {
		start = max(0, min(cursor-maxRows/2, len(rows)-maxRows))
		windowed = true
	}
	row := boxRow
	if windowed && start > 0 {
		stage(relRegion{row: row, kind: clickMoreUp, idx: maxRows})
		row++
	}
	for i := start; i < min(len(rows), start+maxRows); i++ {
		stage(relRegion{row: row, kind: clickRow, idx: i})
		row++
	}
	if windowed && start+maxRows < len(rows) {
		stage(relRegion{row: row, kind: clickMoreDown, idx: maxRows})
	}
	if !windowed {
		return rows
	}
	end := start + maxRows
	out := make([]string, 0, maxRows+2)
	if start > 0 {
		out = append(out, dimStyle.Render(fmt.Sprintf("  ↑ %d more", start)))
	}
	out = append(out, rows[start:end]...)
	if end < len(rows) {
		out = append(out, dimStyle.Render(fmt.Sprintf("  ↓ %d more", len(rows)-end)))
	}
	return out
}

// mouseClicked resolves a left press against the registry. The surface
// that rendered owns every region on screen, so no precedence checks
// are needed beyond the kind.
func (m Model) mouseClicked(msg tea.MouseClickMsg) (tea.Model, tea.Cmd) {
	if msg.Button != tea.MouseLeft {
		return m, nil
	}
	r, ok := regionAt(msg.X, msg.Y)
	if !ok {
		return m, nil
	}
	switch r.kind {
	case clickKey:
		return m.handleKey(r.key)
	case clickModeChip:
		return m.handleKey(keyPress("shift+tab"))
	case clickHintCmd:
		switch r.idx {
		case hintWelcome:
			return m, m.command("/welcome")
		case hintLogin:
			return m, m.openDeviceLogin()
		case hintSettings:
			return m, m.command("/settings")
		}
	case clickOpenURL:
		if m.deviceLogin != nil {
			openBrowser(m.deviceLogin.code.VerificationURIComplete)
		}
	case clickToggle:
		if m.toolsPanel != nil && r.idx < len(m.toolsPanel.names) {
			m.toolsPanel.cursor = r.idx
			name := m.toolsPanel.names[r.idx]
			m.tools.SetEnabled(name, !m.tools.Enabled(name))
		}
	case clickFormField, clickFormEnum, clickFormSave:
		return m.formClick(r)
	case clickMoreUp, clickMoreDown:
		delta := r.idx
		if r.kind == clickMoreUp {
			delta = -delta
		}
		m.shiftListCursor(delta)
	case clickRow:
		return m.rowClick(r.idx)
	}
	return m, nil
}

// rowClick implements the list-row convention everywhere: the first
// click moves the cursor, and clicking the row already under the cursor
// activates it — the same as pressing enter. Transient menus above the
// input (completion, mode picker) use the same path, so their clicks
// run at once only when the row was already selected.
func (m Model) rowClick(idx int) (tea.Model, tea.Cmd) {
	switch {
	case m.welcome != nil:
		return m.welcomeRowClick(idx)
	case m.settings != nil:
		return m.settingsRowClick(idx)
	case m.mcpPanel != nil:
		if m.mcpPanel.form != nil {
			return m, nil // the add form owns the frame; its rows stage their own regions
		}
		if idx != m.mcpPanel.cursor {
			m.mcpPanel.cursor = idx
			return m, nil
		}
	case m.picker != nil:
		if idx != m.picker.cursor {
			m.picker.cursor = idx
			return m, nil
		}
	case m.modelPick != nil:
		if idx != m.modelPick.cursor {
			m.modelPick.cursor = idx
			return m, nil
		}
	case m.modePick != nil:
		if idx != m.modePick.cursor {
			m.modePick.cursor = idx
			return m, nil
		}
	case m.popup != nil:
		if idx != m.popup.cursor {
			m.popup.cursor = idx
			return m, nil
		}
	default:
		return m, nil
	}
	return m.handleKey(keyPress("enter"))
}

// welcomeRowClick applies the row convention to the walkthrough's
// choice lists; steps without rows never see a click.
func (m Model) welcomeRowClick(idx int) (tea.Model, tea.Cmd) {
	w := m.welcome
	switch w.step {
	case welcomeProvider:
		if idx != w.provIdx {
			w.provIdx = idx
			return m, nil
		}
	case welcomeKhateway:
		if idx != w.kCur {
			w.kCur = idx
			return m, nil
		}
	case welcomeModel:
		if idx != w.mCur {
			w.mCur = idx
			return m, nil
		}
	default:
		return m, nil
	}
	return m.handleKey(keyPress("enter"))
}

// settingsRowClick applies the row convention to the overlay's layers.
// An open editor or form owns the frame the way the keys do, so row
// clicks do nothing there.
func (m Model) settingsRowClick(idx int) (tea.Model, tea.Cmd) {
	s := m.settings
	if s.form != nil {
		return m, nil
	}
	switch s.view {
	case viewRows:
		if s.editor != nil {
			return m, nil // keys don't navigate while an editor is open either
		}
		if idx != s.cursor {
			s.cursor = idx
			return m, nil
		}
	case viewProviderList, viewMCPList, viewHookList, viewKeyChoice:
		if idx != s.listCur {
			s.listCur = idx
			return m, nil
		}
	case viewModels:
		if p := s.models; p == nil || p.adding || idx != p.cursor {
			return m, nil
		}
	}
	return m.handleKey(keyPress("enter"))
}

// formClick routes clicks on form rows: text rows focus their field,
// the enum row steps its value, the save row commits. The walkthrough's
// inline custom-provider form speaks the same dialect.
func (m Model) formClick(r region) (tea.Model, tea.Cmd) {
	enter := keyPress("enter")
	if m.welcome != nil && m.welcome.step == welcomeCustom {
		w := m.welcome
		switch r.kind {
		case clickFormField:
			if r.idx <= 1 && w.cField != r.idx {
				w.cField = r.idx
				w.focusCustom()
			}
		case clickFormEnum:
			w.cField = 2
			w.cProto = (w.cProto + 1) % 2
		case clickFormSave:
			w.cField = 3
			return m.handleKey(enter)
		}
		return m, nil
	}
	f := m.activeForm()
	if f == nil {
		return m, nil
	}
	switch r.kind {
	case clickFormField:
		if r.idx < len(f.inputs) && r.idx != f.field {
			f.field = r.idx
			f.focus()
		}
	case clickFormEnum:
		f.field = len(f.inputs)
		f.cycleEnum(1)
	case clickFormSave:
		f.field = len(f.inputs) + 1
		return m.handleKey(enter)
	}
	return m, nil
}

// activeForm returns the server form editing right now: the settings
// overlay's, else the /mcp dialog's add form.
func (m *Model) activeForm() *serverForm {
	if m.settings != nil && m.settings.form != nil {
		return m.settings.form
	}
	if m.mcpPanel != nil && m.mcpPanel.form != nil {
		return m.mcpPanel.form
	}
	return nil
}

// shiftListCursor pages the open overlay's list cursor; delta is the
// window height the clicked ↑/↓ note advertised.
func (m *Model) shiftListCursor(delta int) {
	move := func(cur, hi int) int { return max(0, min(cur+delta, hi)) }
	switch {
	case m.picker != nil:
		m.picker.cursor = move(m.picker.cursor, len(m.picker.entries)-1)
	case m.modelPick != nil:
		m.modelPick.cursor = move(m.modelPick.cursor, len(m.modelPick.list)-1)
	case m.settings != nil:
		s := m.settings
		switch s.view {
		case viewProviderList:
			s.listCur = move(s.listCur, len(m.providerNames())-1)
		case viewMCPList:
			s.listCur = move(s.listCur, len(sortedServerNames(m.cfg.MCPServers))-1)
		case viewHookList:
			s.listCur = move(s.listCur, len(m.hookEntries())-1)
		case viewModels:
			if p := s.models; p != nil {
				p.cursor = move(p.cursor, len(p.list)-1)
			}
		}
	case m.toolsPanel != nil:
		m.toolsPanel.cursor = move(m.toolsPanel.cursor, len(m.toolsPanel.names)-1)
	case m.mcpPanel != nil:
		m.mcpPanel.cursor = move(m.mcpPanel.cursor, len(m.mcpPanel.names)-1)
	}
}
