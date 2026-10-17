package ui

import (
	"strings"

	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/ansi"
	"github.com/charmbracelet/glamour/styles"
)

// Markdown rendering for assistant messages, live while streaming and
// sealed alike (the cursor is the only streaming difference). The theme
// is glamour's dark layout re-authored over the aurora palette: body
// text is hexText, headings step green→cyan→mint, inline and fenced
// code ride the chip background, and all outer margins are zero so the
// answer bar sits flush against the text.

func bptr(b bool) *bool     { return &b }
func sptr(s string) *string { return &s }
func uptr(u uint) *uint     { return &u }

// auroraMarkdown builds the style config fresh each call: the chroma
// set is borrowed from glamour's dark theme (minus its solid background
// slab) and must not be shared with the package-level default.
func auroraMarkdown() ansi.StyleConfig {
	chroma := *styles.DarkStyleConfig.CodeBlock.Chroma
	chroma.Background = ansi.StylePrimitive{}
	return ansi.StyleConfig{
		Document: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				BlockPrefix: "\n",
				BlockSuffix: "\n",
				Color:       sptr(hexText),
			},
		},
		BlockQuote: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{Color: sptr(hexDim)},
			Indent:         uptr(1),
			IndentToken:    sptr("│ "),
		},
		Paragraph: ansi.StyleBlock{},
		List: ansi.StyleList{
			StyleBlock:  ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: sptr(hexText)}},
			LevelIndent: 2,
		},
		Heading: ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{BlockSuffix: "\n"}},
		H1:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: sptr(hexGreenHi), Bold: bptr(true)}},
		H2:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: sptr(hexCyanHi), Bold: bptr(true)}},
		H3:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: sptr(hexMint), Bold: bptr(true)}},
		H4:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Bold: bptr(true)}},
		H5:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Bold: bptr(true)}},
		H6:      ansi.StyleBlock{StylePrimitive: ansi.StylePrimitive{Color: sptr(hexDim), Bold: bptr(true)}},
		// Text carries no color on purpose: glamour renders plain text
		// nodes as the current block ⊕ Text, so a Text color would
		// override headings, block quotes, and list tints. Body text
		// inherits hexText from the document style instead.
		Text:          ansi.StylePrimitive{},
		Strikethrough: ansi.StylePrimitive{CrossedOut: bptr(true)},
		Emph:          ansi.StylePrimitive{Italic: bptr(true)},
		Strong:        ansi.StylePrimitive{Bold: bptr(true)},
		HorizontalRule: ansi.StylePrimitive{
			Color:  sptr(hexBorder),
			Format: "\n──────\n",
		},
		Item:        ansi.StylePrimitive{BlockPrefix: "• "},
		Enumeration: ansi.StylePrimitive{BlockPrefix: ". "},
		Task: ansi.StyleTask{
			Ticked:   "[✓] ",
			Unticked: "[ ] ",
		},
		Link:     ansi.StylePrimitive{Color: sptr(hexCyan), Underline: bptr(true)},
		LinkText: ansi.StylePrimitive{Color: sptr(hexCyanHi), Bold: bptr(true)},
		Image:    ansi.StylePrimitive{Color: sptr(hexCyan), Underline: bptr(true)},
		ImageText: ansi.StylePrimitive{
			Color:  sptr(hexDim),
			Format: "Image: {{.text}} →",
		},
		Code: ansi.StyleBlock{
			StylePrimitive: ansi.StylePrimitive{
				Prefix:          " ",
				Suffix:          " ",
				Color:           sptr(hexMint),
				BackgroundColor: sptr(hexChipBg),
			},
		},
		CodeBlock: ansi.StyleCodeBlock{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{Color: sptr(hexText)},
			},
			Chroma: &chroma,
		},
		Table: ansi.StyleTable{
			StyleBlock: ansi.StyleBlock{
				StylePrimitive: ansi.StylePrimitive{Color: sptr(hexText)},
			},
		},
		DefinitionList:        ansi.StyleBlock{},
		DefinitionTerm:        ansi.StylePrimitive{Bold: bptr(true)},
		DefinitionDescription: ansi.StylePrimitive{BlockPrefix: "\n🠶 "},
		HTMLBlock:             ansi.StyleBlock{},
		HTMLSpan:              ansi.StyleBlock{},
	}
}

// The renderer is cached across messages and rebuilt only when the wrap
// width changes (a resize); the UI runs on one goroutine, so no locking.
var (
	mdRenderer *glamour.TermRenderer
	mdWrap     int
)

// renderMarkdown renders a complete assistant message with glamour.
func renderMarkdown(raw string, width int) string {
	w := width
	if w < 20 {
		w = 20
	}
	if w > 160 {
		w = 160
	}
	if mdRenderer == nil || mdWrap != w {
		r, err := glamour.NewTermRenderer(
			glamour.WithStyles(auroraMarkdown()),
			glamour.WithWordWrap(w),
		)
		if err != nil {
			return raw
		}
		mdRenderer, mdWrap = r, w
	}
	out, err := mdRenderer.Render(raw)
	if err != nil {
		return raw
	}
	return strings.Trim(out, "\n")
}
