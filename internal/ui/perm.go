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

// permPreviewMax caps the preview shown in the approval dialog, reclaiming
// room from the terminal height within a readable range.
func permPreviewMax(height int) int {
	return min(30, max(6, height-12))
}

// permKey handles input while the approval dialog is open: y allows the
// pending call, n and esc decline it.
func (m *Model) permKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "y", "Y", "enter":
		return m.answerPerm(true)
	case "n", "N", "esc":
		return m.answerPerm(false)
	}
	return nil
}

// answerPerm resolves the open dialog and resumes the event pump.
// Approving a plan also switches khode to accept-edits mode: that is
// the contract the plan tool's result reports back to the model.
func (m *Model) answerPerm(allow bool) tea.Cmd {
	if m.perm != nil {
		if m.perm.Kind == agent.KindPlan && allow {
			m.setMode(perm.ModeAcceptEdits)
		}
		m.perm.Answer(allow)
		m.perm = nil
	}
	return m.pump()
}

// permView renders the open dialog: a tool's permission question with
// its change preview, or a whole plan awaiting approval.
func (m *Model) permView() string {
	req := *m.perm
	if req.Kind == agent.KindPlan {
		return m.planView(req)
	}

	title := dialogTitle("permission", fmt.Sprintf("%s · %s", req.Call.Name, req.Risk))
	if target := requestTarget(req.Call.Input); target != "" {
		title += dimStyle.Render(" · " + clip(target, 60))
	}

	var body string
	switch {
	case req.Call.Name == "bash":
		body = cmdStyle.Render("$ "+req.Preview) + "\n" +
			dimStyle.Render("runs in "+m.workdir)
	case req.Preview != "":
		body = colorizeDiff(req.Preview, permPreviewMax(m.height))
	default:
		body = dimStyle.Render("(no preview available)")
	}

	help := keyHint("y", "allow") + dimStyle.Render("  ·  ") +
		keyHint("n/esc", "deny")
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, title, "", body, "", help))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// planView renders the plan-approval dialog: the plan text plus the
// consequence of approving.
func (m *Model) planView(req agent.Request) string {
	title := dialogTitle("plan", "approve to switch to accept-edits")
	body := clipPlain(req.Preview, permPreviewMax(m.height))
	help := keyHint("y", "approve — implement") + dimStyle.Render("  ·  ") +
		keyHint("n/esc", "keep planning")
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, title, "", body, "", help))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

// clipPlain wraps a plain-text dialog body: lines clipped, the whole
// capped with a "(+N more lines)" note.
func clipPlain(s string, maxLines int) string {
	lines := strings.Split(strings.TrimRight(s, "\n"), "\n")
	out := make([]string, 0, min(len(lines), maxLines+1))
	for _, l := range lines {
		if len(out) == maxLines {
			out = append(out, dimStyle.Render(fmt.Sprintf("(+%d more lines)", len(lines)-maxLines)))
			break
		}
		out = append(out, clip(l, 160))
	}
	return strings.Join(out, "\n")
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
// removals red, hunk headers dim; output beyond maxLines is cut with a
// note.
func colorizeDiff(diff string, maxLines int) string {
	lines := strings.Split(strings.TrimRight(diff, "\n"), "\n")
	out := make([]string, 0, min(len(lines), maxLines+1))
	for _, l := range lines {
		if len(out) == maxLines {
			out = append(out, dimStyle.Render(fmt.Sprintf("(+%d more lines)", len(lines)-maxLines)))
			break
		}
		l = clip(l, 160)
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
