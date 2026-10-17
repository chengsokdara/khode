package ui

import (
	"fmt"
	"image/color"
	"math"
	"time"

	"charm.land/lipgloss/v2"

	"khode/internal/config"
)

// The icon table: every glyph the chat draws to mark a message kind or a
// tool, one pack per config.IconSet value. "auto" rides packUnicode —
// width-one monochrome symbols safe on every terminal; "nerd" swaps in
// Nerd Font icons (needs a patched terminal font, so it is an opt-in);
// "ascii" degrades to plain punctuation for dumb terminals. The ⎿ result
// connector is grammar rather than an icon, so it stays a literal in
// every pack.

type iconPack struct {
	user     string // the prompt mark on user messages
	agent    string // khode's own prose and status
	thinking string // the model's private reasoning
	tool     string // uniform tool-call mark (unicode keeps Claude Code's ⏺)
	system   string // UI notices
	err      string // turn-level failures
	ready    string // the idle status dot
	gather   string // the first-prompt context gatherer
	context  string // the gathered context brief
	todo     string // the checklist panel title
	queued   string // prompts held while a turn runs
	// tools overrides the uniform tool mark per tool name; a missing
	// name falls back to tool.
	tools map[string]string
}

var packUnicode = iconPack{
	user:     "❯",
	agent:    "✦",
	thinking: "✻",
	tool:     "⏺",
	system:   "·",
	err:      "✗",
	ready:    "●",
	gather:   "◆",
	context:  "◆",
	todo:     "◆",
	queued:   "…",
}

// packNerd's codepoints come from Nerd Fonts v3's glyphnames.json:
// sparkles/brain for the agent's two voices, then per-tool marks so a
// scan of the scrollback reads what ran without parsing the line.
// Codepoints above U+FFFF use the 8-digit \U escape — \u takes exactly
// four hex digits, and a 5-digit \u silently becomes glyph + stray digit.
var packNerd = iconPack{
	user:     "\uf007",     // fa-user
	agent:    "\U000F0674", // md-creation (sparkles)
	thinking: "\U000F09D1", // md-brain
	tool:     "\U000F0BE0", // md-wrench-outline
	system:   "\U000F02FD", // md-information-outline
	err:      "\U000F05D6", // md-alert-circle-outline
	ready:    "●",
	gather:   "\U000F0349", // md-magnify
	context:  "\U000F0982", // md-map-outline
	todo:     "\U000F0756", // md-format-list-checks
	queued:   "\U000F004C", // md-pause
	tools: map[string]string{
		"read":  "\U000F14F7", // md-book-open-variant
		"edit":  "\U000F03EB", // md-pencil
		"write": "\U000F0EED", // md-file-plus-outline
		"bash":  "\U000F018D", // md-console
		"glob":  "\U000F0969", // md-folder-search-outline
		"grep":  "\U000F0349", // md-magnify
		"task":  "\U000F0849", // md-account-group
		"plan":  "\U000F018C", // md-compass-outline
		"todo":  "\U000F0756", // md-format-list-checks
	},
}

var packASCII = iconPack{
	user:     ">",
	agent:    "*",
	thinking: "~",
	tool:     "o",
	system:   "-",
	err:      "x",
	ready:    "+",
	gather:   "+",
	context:  "-",
	todo:     "#",
	queued:   ".",
}

// packFor maps a config.IconSet value to its glyph pack; anything
// unrecognized rides the safe Unicode pack.
func packFor(set string) iconPack {
	switch set {
	case config.IconNerd:
		return packNerd
	case config.IconASCII:
		return packASCII
	}
	return packUnicode
}

// icons returns the pack the user's config selected.
func (m Model) icons() iconPack { return packFor(m.cfg.IconSet()) }

// toolMark picks the glyph a tool call draws: the pack's per-tool icon
// when it has one, the uniform tool mark otherwise.
func toolMark(p iconPack, name string) string {
	if g, ok := p.tools[name]; ok && g != "" {
		return g
	}
	return p.tool
}

// --- the working animation ---------------------------------------------------

// breathPeriod is one full cyan→mint→cyan cycle of the working
// animation: slow enough to read as breathing, fast enough to stay alive.
const breathPeriod = 2200 * time.Millisecond

// breathColor tints the working animation: a sine breath between the
// palette's cyan and its pale mint, phased by the turn clock so the
// spinner tick that already re-renders the live region animates it for
// free — no extra tick plumbing.
func breathColor(elapsed time.Duration) color.Color {
	frac := (math.Sin(float64(elapsed)/float64(breathPeriod)*2*math.Pi) + 1) / 2
	return lipgloss.Color(lerpHex(hexCyan, hexMint, frac))
}

// lerpHex blends two "#rrggbb" colors; unparseable input falls back to
// the start color.
func lerpHex(from, to string, frac float64) string {
	f, errF := parseHex(from)
	t, errT := parseHex(to)
	if errF != nil || errT != nil {
		return from
	}
	return fmt.Sprintf("#%02x%02x%02x",
		u8(f[0]+(t[0]-f[0])*frac),
		u8(f[1]+(t[1]-f[1])*frac),
		u8(f[2]+(t[2]-f[2])*frac))
}

// breathElapsed is the in-flight turn's age — the clock every breathing
// element is phased against, so they swell together. A zero turnStart
// (no turn in flight) renders the breath's resting point.
func (m Model) breathElapsed() time.Duration {
	if m.turnStart.IsZero() {
		return 0
	}
	return time.Since(m.turnStart)
}

// breathStyle is a foreground style carrying the breath's tint.
func breathStyle(elapsed time.Duration) lipgloss.Style {
	return lipgloss.NewStyle().Foreground(breathColor(elapsed))
}

// shimmerColor tints one cell of the header's animated rule: a bright
// band traveling along the quiet border teal, fading smoothly into it
// on both sides. pos is the cell's position around the rule (0..1) and
// travel is the band center's position at this instant (0..1); the
// distance wraps so the band flows across the rule's ends.
func shimmerColor(pos, travel float64) color.Color {
	d := math.Abs(pos - travel)
	if d > 0.5 {
		d = 1 - d
	}
	k := math.Cos(d * math.Pi * 3) // smooth bump, half-width ⅙ of the rule
	if k < 0 {
		k = 0
	}
	return lipgloss.Color(lerpHex(hexBorder, hexCyanHi, k))
}

// --- the status line's live phase --------------------------------------------

// toolVerbs names what a tool call is doing, for the status line's verb.
var toolVerbs = map[string]string{
	"read":  "reading",
	"edit":  "editing",
	"write": "writing",
	"bash":  "running",
	"glob":  "scanning",
	"grep":  "searching",
	"task":  "delegating",
	"plan":  "planning",
	"todo":  "planning",
}

// phaseVerb is the status line's verb for what khode is doing right
// now; m.phase carries the live phase ("thinking", "responding", or a
// tool name) and m.gathering overrides everything.
func (m Model) phaseVerb() string {
	if m.gathering {
		return "gathering context"
	}
	switch m.phase {
	case "":
		return "working"
	case "thinking", "responding":
		return m.phase
	}
	if v, ok := toolVerbs[m.phase]; ok {
		return v
	}
	return "calling " + m.phase
}

// statusGlyph picks the glyph the breathing status mark draws this
// instant: the live phase's own icon where one exists, the agent mark
// otherwise.
func (m Model) statusGlyph() string {
	p := m.icons()
	switch m.phase {
	case "thinking":
		return p.thinking
	case "responding":
		return p.agent
	case "":
		if m.gathering {
			return p.gather
		}
		return p.agent
	}
	return toolMark(p, m.phase)
}
