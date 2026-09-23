package ui

import (
	"fmt"
	"strings"

	"khode/internal/perm"

	"charm.land/lipgloss/v2"
)

// The khode visual language — "aurora": green and cyan over the
// terminal's own dark background. Every view draws its colors from
// here so the whole app reads as one piece. The semantics are fixed:
// cyan is khode's own activity (borders, tools, keys), green is good
// (ready, saved, additions), red is error, amber is context pressure,
// and dim gray-teal carries everything secondary.

// The palette is declared as raw hex first so non-lipgloss renderers
// (the glamour markdown theme) can speak the exact same colors.
const (
	hexCyan    = "#2DD4BF"
	hexCyanHi  = "#5EEAD4"
	hexGreen   = "#4ADE80"
	hexGreenHi = "#86EFAC"
	hexMint    = "#99F6E4"
	hexText    = "#DCE9E5"
	hexResult  = "#8FA8A3"
	hexDim     = "#5C6B73"
	hexBorder  = "#24544E"
	hexChipBg  = "#0F3532"
	hexUserBg  = "#123524"
	hexErr     = "#F87171"
	hexWarn    = "#FBBF24"
)

var (
	colCyan    = lipgloss.Color(hexCyan)
	colCyanHi  = lipgloss.Color(hexCyanHi)
	colGreen   = lipgloss.Color(hexGreen)
	colGreenHi = lipgloss.Color(hexGreenHi)
	colMint    = lipgloss.Color(hexMint)
	colResult  = lipgloss.Color(hexResult)
	colDim     = lipgloss.Color(hexDim)
	colBorder  = lipgloss.Color(hexBorder)
	colChipBg  = lipgloss.Color(hexChipBg)
	colUserBg  = lipgloss.Color(hexUserBg)
	colErr     = lipgloss.Color(hexErr)
	colWarn    = lipgloss.Color(hexWarn)
)

// Central component styles so views stay consistent.
var (
	titleStyle = lipgloss.NewStyle().Bold(true).Foreground(colCyanHi).Padding(0, 1)
	dimStyle   = lipgloss.NewStyle().Foreground(colDim)
	// userMark is the ❯ prompt on user messages.
	userMark = lipgloss.NewStyle().Bold(true).Foreground(colGreen)

	// userCard bands user messages onto a full-width dark-green slab:
	// green reads as "you" against khode's cyan answer bars, and the
	// container-vs-prose shape keeps the two apart when scanning a long
	// transcript.
	userCard    = lipgloss.NewStyle().Background(colUserBg).Padding(0, 1)
	cmdStyle    = lipgloss.NewStyle().Foreground(colGreenHi)
	systemStyle = lipgloss.NewStyle().Foreground(colDim).Italic(true)
	errorStyle  = lipgloss.NewStyle().Foreground(colErr).Bold(true)
	statusStyle = lipgloss.NewStyle().Foreground(colCyanHi)
	okStyle     = lipgloss.NewStyle().Foreground(colGreen)
	toolStyle   = lipgloss.NewStyle().Bold(true).Foreground(colCyan)
	thinkStyle  = lipgloss.NewStyle().Foreground(colDim).Italic(true)

	// resultStyle carries tool output: real content, one step quieter
	// than prose, clearly apart from the dim italic thinking/system
	// notes.
	resultStyle = lipgloss.NewStyle().Foreground(colResult)
	addStyle    = lipgloss.NewStyle().Foreground(colGreen)
	delStyle    = lipgloss.NewStyle().Foreground(colErr)
	warnStyle   = lipgloss.NewStyle().Foreground(colWarn)

	// pickSel marks whatever a list cursor rests on.
	pickSel = lipgloss.NewStyle().Bold(true).Foreground(colCyanHi)

	// exampleStyle tints suggested prompts in the ready card.
	exampleStyle = lipgloss.NewStyle().Foreground(colMint)

	// streamCursor is the block that trails a streaming reply.
	streamCursor = lipgloss.NewStyle().Bold(true).Foreground(colCyan)

	// answerBar marks assistant prose with a left rule: dim teal while
	// the turn is still running, bright cyan on the turn's final answer.
	// Both carry exactly answerBarOverhead columns; the chat renderer
	// subtracts that from the markdown wrap width.
	answerBarOverhead = 2
	answerBar         = lipgloss.NewStyle().Border(lipgloss.ThickBorder(), false, false, false, true).BorderForeground(colBorder).PaddingLeft(1)
	answerBarFinal    = lipgloss.NewStyle().Border(lipgloss.ThickBorder(), false, false, false, true).BorderForeground(colCyan).PaddingLeft(1)

	// scrollThumb/scrollTrack draw the approval dialog's scrollbar
	// gutter, two cells wide: a cyan full-block thumb over a quiet
	// light-shade track. One glyph family keeps them aligned in any
	// font (a half-block next to a line does not line up in iTerm2).
	scrollThumb = lipgloss.NewStyle().Foreground(colCyan)
	scrollTrack = lipgloss.NewStyle().Foreground(colDim)

	// helpKey dims the bottom-line key names without hiding them.
	helpKey = lipgloss.NewStyle().Foreground(colCyan).Faint(true)

	// keycap renders footer key names as quiet chips: findable, not
	// wallpaper.
	keycapStyle = lipgloss.NewStyle().Background(colChipBg).Foreground(colCyanHi).Padding(0, 1)

	// modeChip shows the active permission mode in the header.
	modeChip = lipgloss.NewStyle().Background(colChipBg).Foreground(colCyanHi).Padding(0, 1)

	inputBorder     = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colBorder)
	inputBorderLive = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colCyan)
	dialogBorder    = lipgloss.NewStyle().Border(lipgloss.RoundedBorder()).BorderForeground(colCyan).Padding(1, 2)
	viewportStyle   = lipgloss.NewStyle().Padding(0, 1)
)

// modeAccent styles the mode line and the /mode picker rows by what the
// mode lets the agent do, staying inside the palette's fixed semantics:
// cyan is khode inspecting (plan), green is the good middle
// (accept-edits), amber is caution (auto runs everything). ask never
// reaches it — the mode line hides in the default mode.
func modeAccent(mo perm.Mode) lipgloss.Style {
	switch mo {
	case perm.ModePlan:
		return lipgloss.NewStyle().Foreground(colCyan)
	case perm.ModeAcceptEdits:
		return lipgloss.NewStyle().Foreground(colGreen)
	case perm.ModeAuto:
		return lipgloss.NewStyle().Foreground(colWarn)
	}
	return dimStyle
}

// gradient blends s from one hex color to another across its runes,
// letting lipgloss degrade the intermediate colors to whatever the
// terminal supports. It is reserved for the wordmark; everywhere else
// uses flat palette colors.
func gradient(s, from, to string) string {
	f, errF := parseHex(from)
	t, errT := parseHex(to)
	if errF != nil || errT != nil {
		return s
	}
	runes := []rune(s)
	style := lipgloss.NewStyle().Bold(true)
	var b strings.Builder
	for i, r := range runes {
		frac := 0.0
		if len(runes) > 1 {
			frac = float64(i) / float64(len(runes)-1)
		}
		hex := fmt.Sprintf("#%02x%02x%02x",
			u8(f[0]+(t[0]-f[0])*frac),
			u8(f[1]+(t[1]-f[1])*frac),
			u8(f[2]+(t[2]-f[2])*frac))
		b.WriteString(style.Foreground(lipgloss.Color(hex)).Render(string(r)))
	}
	return b.String()
}

// parseHex reads "#rrggbb" into 8-bit channels. Sscanf's %x wants
// integers, so the scan lands in ints before the float conversion.
func parseHex(s string) ([3]float64, error) {
	var c [3]float64
	if len(s) != 7 || s[0] != '#' {
		return c, fmt.Errorf("not a #rrggbb color: %q", s)
	}
	var r, g, b int
	_, err := fmt.Sscanf(s, "#%02x%02x%02x", &r, &g, &b)
	if err != nil {
		return c, err
	}
	return [3]float64{float64(r), float64(g), float64(b)}, nil
}

func u8(v float64) int { return min(255, max(0, int(v+0.5))) }

// logo renders the khode wordmark: a green diamond ahead of the
// green→cyan gradient name.
func logo() string {
	return lipgloss.NewStyle().Bold(true).Foreground(colGreen).Render("◆ ") +
		gradient("khode", "#4ADE80", "#2DD4BF")
}

// dialogTitle renders one overlay header: the diamond mark, the bold
// name, and the dim subtitle every dialog carries.
func dialogTitle(name, sub string) string {
	return titleStyle.Render("◆ "+name) + dimStyle.Render("  "+sub)
}

// keyHint renders one footer fragment: the key name as a chip, the
// verb dim.
func keyHint(keyName, verb string) string {
	return keycapStyle.Render(keyName) + dimStyle.Render(" "+verb)
}

// flash styles a ✓/✗ status message; neutral notes stay dim.
func flash(msg string) string {
	switch {
	case strings.HasPrefix(msg, "✓"):
		return okStyle.Render(msg)
	case strings.HasPrefix(msg, "✗"):
		return errorStyle.Render(msg)
	}
	return dimStyle.Render(msg)
}

// meter renders a fullness bar: ▰ cells fill green toward the target,
// flipping to amber under pressure.
func meter(frac float64, width int, warn bool) string {
	fill := int(frac * float64(width))
	fill = min(width, max(0, fill))
	style := addStyle
	if warn {
		style = warnStyle
	}
	return style.Render(strings.Repeat("▰", fill)) +
		dimStyle.Render(strings.Repeat("▱", width-fill))
}

// listMaxRows caps a dialog list: the box around it costs six rows
// (title, blanks, footer, border), and the whole overlay has to fit the
// inline frame budget, so the cap shrinks with the terminal.
func listMaxRows(height int) int {
	return min(12, max(4, height-10))
}

// listWindow slices a rendered dialog list to maxRows around the
// cursor, marking the cut ends with count notes. Config-grown lists
// (providers, MCP servers, hooks, sessions) stay inside the overlay's
// height budget this way.
func listWindow(rows []string, cursor int, maxRows int) []string {
	if len(rows) <= maxRows {
		return rows
	}
	start := max(0, min(cursor-maxRows/2, len(rows)-maxRows))
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
