package ui

import (
	"fmt"
	"strings"

	"charm.land/lipgloss/v2"
)

// The khode visual language — "aurora": green and cyan over the
// terminal's own dark background. Every view draws its colors from
// here so the whole app reads as one piece. The semantics are fixed:
// cyan is khode's own activity (borders, tools, keys), green is good
// (ready, saved, additions), red is error, amber is context pressure,
// and dim gray-teal carries everything secondary.

var (
	colCyan    = lipgloss.Color("#2DD4BF")
	colCyanHi  = lipgloss.Color("#5EEAD4")
	colGreen   = lipgloss.Color("#4ADE80")
	colGreenHi = lipgloss.Color("#86EFAC")
	colMint    = lipgloss.Color("#99F6E4")
	colDim     = lipgloss.Color("#5C6B73")
	colBorder  = lipgloss.Color("#24544E")
	colChipBg  = lipgloss.Color("#0F3532")
	colErr     = lipgloss.Color("#F87171")
	colWarn    = lipgloss.Color("#FBBF24")
)

// Central component styles so views stay consistent.
var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(colCyanHi).Padding(0, 1)
	dimStyle    = lipgloss.NewStyle().Foreground(colDim)
	userMark    = lipgloss.NewStyle().Bold(true).Foreground(colGreen)
	cmdStyle    = lipgloss.NewStyle().Foreground(colGreenHi)
	systemStyle = lipgloss.NewStyle().Foreground(colDim).Italic(true)
	errorStyle  = lipgloss.NewStyle().Foreground(colErr).Bold(true)
	statusStyle = lipgloss.NewStyle().Foreground(colCyanHi)
	okStyle     = lipgloss.NewStyle().Foreground(colGreen)
	toolStyle   = lipgloss.NewStyle().Bold(true).Foreground(colCyan)
	thinkStyle  = lipgloss.NewStyle().Foreground(colDim).Italic(true)
	resultStyle = lipgloss.NewStyle().Foreground(colDim)
	addStyle    = lipgloss.NewStyle().Foreground(colGreen)
	delStyle    = lipgloss.NewStyle().Foreground(colErr)
	warnStyle   = lipgloss.NewStyle().Foreground(colWarn)

	// pickSel marks whatever a list cursor rests on.
	pickSel = lipgloss.NewStyle().Bold(true).Foreground(colCyanHi)

	// exampleStyle tints suggested prompts in the ready card.
	exampleStyle = lipgloss.NewStyle().Foreground(colMint)

	// streamCursor is the block that trails a streaming reply.
	streamCursor = lipgloss.NewStyle().Bold(true).Foreground(colCyan)

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
