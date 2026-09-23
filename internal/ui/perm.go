package ui

import (
	"encoding/json"
	"fmt"
	"strings"

	"khode/internal/agent"
	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// permRequestMsg carries one permission question from the agent loop.
type permRequestMsg struct{ req agent.Request }

// permBodyWidth is the wrap width of a dialog body: the terminal minus
// the box chrome (border and padding), the scrollbar gutter, and a
// margin, held to a readable range so wide terminals don't stretch
// prose across the screen.
func permBodyWidth(width int) int {
	return max(30, min(100, width-12))
}

// permBodyRows is how many body rows a dialog shows at once: the box
// around it costs roughly a dozen rows (title, blanks, footer, border),
// so the window shrinks with the terminal. Bodies longer than the
// window scroll instead of truncating.
func permBodyRows(height int) int {
	return max(6, height-12)
}

// permScrollMax bounds the dialog scroll offset so one keypress can
// always reach either end without knowing the body height; the view
// clamps the offset to the real content.
const permScrollMax = 1 << 20

// permKey handles input while the approval dialog is open: y allows the
// pending call, n and esc decline it, shift+tab cycles the permission
// mode — and lets the cycle resolve the dialog itself when the new mode
// would have allowed the pending call outright. The scroll keys page
// through the dialog body (plan markdown, change previews).
func (m *Model) permKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "shift+tab":
		m.cycleMode()
		return m.autoResolvePerm()
	case "y", "Y", "enter":
		return m.answerPerm(true)
	case "n", "N", "esc":
		return m.answerPerm(false)
	case "up", "k":
		m.scrollPerm(-1)
	case "down", "j":
		m.scrollPerm(1)
	case "pgup":
		m.scrollPerm(-permBodyRows(m.height))
	case "pgdown":
		m.scrollPerm(permBodyRows(m.height))
	case "home", "g":
		m.scrollPerm(-permScrollMax)
	case "end", "G":
		m.scrollPerm(permScrollMax)
	}
	return nil
}

// scrollPerm moves the open dialog's scroll offset, clamped to a coarse
// bound; dialogWindow pins it to the actual content height.
func (m *Model) scrollPerm(delta int) {
	m.permScroll = max(0, min(permScrollMax, m.permScroll+delta))
}

// clampScroll pins an offset to the last full window over total lines.
func clampScroll(offset, total, rows int) int {
	return max(0, min(offset, total-rows))
}

// The open dialog's rendered body is cached: glamour runs once per plan
// text and wrap width, not on every frame. Only one dialog can be open
// at a time, so a single (key, width) entry serves plan markdown and
// change previews alike.
var (
	dlgKey   string
	dlgWidth int
	dlgLines []string
)

// dialogLines returns the dialog body rendered to lines, re-rendering
// only when the text or width changed. render is lazy so a cache hit
// skips the expensive pass entirely.
func dialogLines(key string, width int, render func() string) []string {
	if key == dlgKey && width == dlgWidth {
		return dlgLines
	}
	dlgKey, dlgWidth = key, width
	dlgLines = strings.Split(render(), "\n")
	return dlgLines
}

// dialogWindow slices the dialog body to permBodyRows at the scroll
// offset. An overflowing body draws a scrollbar gutter down the right
// edge; rows are padded to the body width first so the gutter column
// stays aligned across ANSI-styled lines.
func (m Model) dialogWindow(lines []string) string {
	rows := permBodyRows(m.height)
	total := len(lines)
	if total <= rows {
		return strings.Join(lines, "\n")
	}
	offset := clampScroll(m.permScroll, total, rows)
	pad := lipgloss.NewStyle().Width(permBodyWidth(m.width))
	thumbSize := max(1, rows*rows/total)
	thumbPos := offset * (rows - thumbSize) / (total - rows)
	out := make([]string, 0, rows)
	for i := range rows {
		gutter := scrollTrack.Render("│")
		if i >= thumbPos && i < thumbPos+thumbSize {
			gutter = scrollThumb.Render("▐")
		}
		out = append(out, pad.Render(lines[offset+i])+"  "+gutter)
	}
	return strings.Join(out, "\n")
}

// scrollHints is the leading footer fragment of a dialog whose body
// overflows its window.
func scrollHints() string {
	return keyHint("↑↓/pgup/pgdn", "scroll") + dimStyle.Render("  ·  ") +
		keyHint("home/end", "jump") + dimStyle.Render("  ·  ")
}

// autoResolvePerm approves an open dialog when the just-switched mode
// allows the pending call: staying in ask mode must not keep blocking a
// call the user has effectively cleared. Asks the new mode still poses
// (bash under accept-edits) or denies (plan mode) stay open for a
// manual answer, and plan approvals are never auto-resolved — that
// choice stays the user's.
func (m *Model) autoResolvePerm() tea.Cmd {
	if m.perm == nil || m.perm.Kind != agent.KindTool {
		return nil
	}
	if perm.Decide(m.mode(), m.perm.Risk) != perm.DecisionAllow {
		return nil
	}
	return m.answerPerm(true)
}

// answerPerm resolves the open dialog and resumes the event pump.
// Approving a plan also switches khode to accept-edits mode: that is
// the contract the plan tool's result reports back to the model. The
// flush carries the mode-change notice to scrollback (setMode appends
// it); it no-ops when nothing sealed is pending.
func (m *Model) answerPerm(allow bool) tea.Cmd {
	if m.perm != nil {
		if m.perm.Kind == agent.KindPlan && allow {
			m.setMode(perm.ModeAcceptEdits)
		}
		m.perm.Answer(allow)
		m.perm = nil
	}
	return tea.Batch(m.flush(), m.pump())
}

// permView renders the open dialog: a tool's permission question with
// its change preview, or a whole plan awaiting approval. Both bodies
// scroll when they outgrow the window.
func (m *Model) permView() string {
	req := *m.perm
	if req.Kind == agent.KindPlan {
		return m.planView(req)
	}

	title := dialogTitle("permission", fmt.Sprintf("%s · %s", req.Call.Name, req.Risk))
	if target := requestTarget(req.Call.Input); target != "" {
		title += dimStyle.Render(" · " + clip(target, 60))
	}

	w := permBodyWidth(m.width)
	var lines []string
	switch {
	case req.Call.Name == "bash":
		lines = []string{
			cmdStyle.Render("$ " + clip(req.Preview, w-2)),
			dimStyle.Render("runs in " + m.workdir),
		}
	case req.Preview != "":
		preview := req.Preview
		lines = dialogLines("diff\x00"+preview, w,
			func() string { return colorizeDiff(preview, w) })
	default:
		lines = []string{dimStyle.Render("(no preview available)")}
	}

	help := keyHint("y", "allow") + dimStyle.Render("  ·  ") +
		keyHint("n/esc", "deny") + dimStyle.Render("  ·  ") +
		keyHint("shift+tab", "cycle mode")
	if len(lines) > permBodyRows(m.height) {
		help = scrollHints() + help
	}
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left,
		title, "", m.dialogWindow(lines), "", help))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// planView renders the plan-approval dialog: the plan rendered as
// markdown in a scrollable window, plus the consequence of approving.
func (m *Model) planView(req agent.Request) string {
	title := dialogTitle("plan", "approve to switch to accept-edits")
	w := permBodyWidth(m.width)
	preview := req.Preview
	lines := dialogLines("plan\x00"+preview, w,
		func() string { return renderMarkdown(preview, w) })

	help := keyHint("y", "approve — implement") + dimStyle.Render("  ·  ") +
		keyHint("n/esc", "keep planning")
	if len(lines) > permBodyRows(m.height) {
		help = scrollHints() + help
	}
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left,
		title, "", m.dialogWindow(lines), "", help))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// requestTarget extracts a path argument for the dialog title.
func requestTarget(args json.RawMessage) string {
	var a struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return ""
	}
	return a.Path
}

// colorizeDiff renders a unified diff for the dialog: additions green,
// removals red, hunk headers dim. Long lines clip to the body width so
// the scrollbar gutter stays aligned.
func colorizeDiff(diff string, width int) string {
	lines := strings.Split(strings.TrimRight(diff, "\n"), "\n")
	out := make([]string, 0, len(lines))
	for _, l := range lines {
		l = clip(l, width)
		switch {
		case strings.HasPrefix(l, "+"):
			out = append(out, addStyle.Render(l))
		case strings.HasPrefix(l, "-"):
			out = append(out, delStyle.Render(l))
		case strings.HasPrefix(l, "@@"):
			out = append(out, dimStyle.Render(l))
		default:
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// modeDescription is the /mode picker blurb for one permission mode.
func modeDescription(mo perm.Mode) string {
	switch mo {
	case perm.ModePlan:
		return "read-only: khode inspects and plans, nothing is modified"
	case perm.ModeAsk:
		return "ask before every file change and command"
	case perm.ModeAcceptEdits:
		return "file changes run freely; commands still ask"
	case perm.ModeAuto:
		return "everything runs without asking"
	}
	return ""
}
