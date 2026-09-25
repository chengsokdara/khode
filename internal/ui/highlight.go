package ui

// Syntax highlighting for diff content, Grok style: the code keeps its
// language colors and sits on full-width background bands — dark green
// over additions, dark red over removals — behind a dim line-number
// gutter, with no + / - markers. Chroma (glamour's lexer) does the
// lexing; the token palette is VSCode Dark+ (see auroraChroma).

import (
	"bytes"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/charmbracelet/x/ansi"
)

// auroraChroma speaks to chroma's truecolor formatter. The code
// palette is VSCode Dark+ — the vivid scheme Grok renders: blue
// keywords, purple control flow, orange strings, yellow functions,
// light-blue variables, teal classes, green comments — while the chrome
// around the code stays aurora. Entries are Pygments-style descriptors:
// color plus optional bold/italic.
var auroraChroma = chroma.MustNewStyle("khode", chroma.StyleEntries{
	chroma.Text:                "#D4D4D4",
	chroma.Comment:             "#6A9955",
	chroma.CommentPreproc:      "#C586C0",
	chroma.Keyword:             "#C586C0",
	chroma.KeywordDeclaration:  "#569CD6",
	chroma.KeywordNamespace:    "#C586C0",
	chroma.KeywordType:         "#569CD6",
	chroma.KeywordConstant:     "#569CD6",
	chroma.Operator:            "#D4D4D4",
	chroma.Punctuation:         "#D4D4D4",
	chroma.LiteralString:       "#CE9178",
	chroma.LiteralStringEscape: "#D7BA7D",
	chroma.LiteralNumber:       "#B5CEA8",
	chroma.Name:                "#9CDCFE",
	chroma.NameOther:           "#9CDCFE",
	chroma.NameVariable:        "#9CDCFE",
	chroma.NameConstant:        "#4FC1FF",
	chroma.NameFunction:        "#DCDCAA",
	chroma.NameClass:           "#4EC9B0",
	chroma.NameBuiltin:         "#4EC9B0",
	chroma.NameTag:             "#569CD6",
	chroma.NameAttribute:       "#9CDCFE",
	chroma.NameDecorator:       "#DCDCAA",
	chroma.NameLabel:           "#C586C0",
	chroma.GenericHeading:      "#569CD6 bold",
	chroma.GenericSubheading:   "#4EC9B0 bold",
	chroma.GenericDeleted:      "#F87171",
	chroma.GenericInserted:     "#4ADE80",
	chroma.GenericEmph:         "#D4D4D4 italic",
	chroma.GenericStrong:       "#D4D4D4 bold",
})

// highlightLines renders code with chroma in the aurora style, one
// styled line per input line. The lexer is picked by file name only —
// content sniffing would highlight unrelated text — and without a
// match (or if the formatter drifts off the input's line count) the
// lines come back plain.
func highlightLines(code, path string) []string {
	lines := strings.Split(code, "\n")
	lexer := lexers.Match(path)
	if lexer == nil {
		return lines
	}
	it, err := lexer.Tokenise(nil, code)
	if err != nil {
		return lines
	}
	var buf bytes.Buffer
	if err := formatters.TTY16m.Format(&buf, auroraChroma, it); err != nil {
		return lines
	}
	out := strings.Split(strings.TrimSuffix(buf.String(), "\n"), "\n")
	if len(out) != len(lines) {
		// Chroma folds a trailing newline away, so a run ending in a
		// blank line comes back one row short — pad it back before
		// giving up on the highlighting.
		if len(out) == len(lines)-1 && strings.HasSuffix(code, "\n") {
			return append(out, "")
		}
		return lines
	}
	return out
}

// renderDiffLines styles a unified diff Grok-style: a dim line-number
// gutter, syntax-highlighted code, and full-width background bands —
// dark green over additions, dark red over removals — instead of +/-
// markers. Hunk headers are parsed for the line numbers and dropped.
// Consecutive lines of one kind lex as a single snippet, so multi-line
// comments and strings survive.
func renderDiffLines(diff, path string, width int) []string {
	if strings.TrimSpace(diff) == "" {
		return nil
	}
	lines := strings.Split(strings.TrimRight(diff, "\n"), "\n")

	// The gutter is as wide as the largest line number either side
	// shows, so every hunk of the diff lines up.
	gutter := 2
	for _, l := range lines {
		if a, b, c, d, ok := hunkHeader(l); ok {
			if b > 0 {
				gutter = max(gutter, digits(a+b-1))
			}
			if d > 0 {
				gutter = max(gutter, digits(c+d-1))
			}
		}
	}

	out := make([]string, 0, len(lines))
	oldLine, newLine := 0, 0
	for i := 0; i < len(lines); {
		if a, _, c, _, ok := hunkHeader(lines[i]); ok {
			oldLine, newLine = a, c
			i++
			continue
		}
		marker := diffMarker(lines[i])
		j := i + 1
		for j < len(lines) && !strings.HasPrefix(lines[j], "@@") && diffMarker(lines[j]) == marker {
			j++
		}
		code := make([]string, j-i)
		for k := i; k < j; k++ {
			code[k-i] = stripMarker(lines[k])
		}
		hl := highlightLines(strings.Join(code, "\n"), path)
		for k := i; k < j; k++ {
			var num int
			switch marker {
			case '-':
				num, oldLine = oldLine, oldLine+1
			case '+':
				num, newLine = newLine, newLine+1
			default:
				num, oldLine, newLine = newLine, oldLine+1, newLine+1
			}
			body := hl[k-i]
			if w := gutter + 1; lipgloss.Width(body) > width-w {
				body = ansi.Truncate(body, width-w, "")
			}
			line := dimStyle.Render(fmt.Sprintf("%*d ", gutter, num)) + body
			switch marker {
			case '+':
				out = append(out, bandLine(line, hexDiffAddBg, width))
			case '-':
				out = append(out, bandLine(line, hexDiffDelBg, width))
			default:
				out = append(out, line)
			}
		}
		i = j
	}
	return out
}

// hunkHeader parses a unified-diff header "@@ -a,b +c,d @@" into its
// four numbers.
func hunkHeader(line string) (a, b, c, d int, ok bool) {
	n, _ := fmt.Sscanf(line, "@@ -%d,%d +%d,%d @@", &a, &b, &c, &d)
	return a, b, c, d, n == 4
}

// stripMarker removes a unified-diff line's kind prefix; unprefixed
// lines (never produced by our differ, defensive for hand edits) pass
// through whole.
func stripMarker(line string) string {
	if line == "" {
		return ""
	}
	switch line[0] {
	case '+', '-', ' ':
		return line[1:]
	}
	return line
}

// digits is n's width in decimal.
func digits(n int) int {
	return len(strconv.Itoa(n))
}

// diffMarker returns a unified-diff line's kind byte: '+', '-', or ' '
// for context (hunk headers are parsed before this runs). Malformed
// lines read as context so they still render.
func diffMarker(line string) byte {
	if line == "" {
		return ' '
	}
	switch line[0] {
	case '+', '-':
		return line[0]
	}
	return ' '
}

// resetRe matches every SGR reset form the parts of a diff row emit —
// lipgloss writes the short \x1b[m, chroma the long \x1b[0m.
var resetRe = regexp.MustCompile(`\x1b\[0*m`)

// bandLine wraps a styled line in a full-width background band — the
// dark green/red rows behind diff lines. The row's parts each reset
// their own SGR (the lipgloss gutter in short form, chroma's tokens in
// long form), and any of those resets wipes the band, so every reset is
// stripped instead: each token already sets its own foreground, and a
// single reset closes the row. The row is padded out to the full width
// inside the band.
func bandLine(line string, bgHex string, width int) string {
	c, err := parseHex(bgHex)
	if err != nil {
		return line
	}
	bg := fmt.Sprintf("\x1b[48;2;%d;%d;%dm", int(c[0]), int(c[1]), int(c[2]))
	line = resetRe.ReplaceAllString(line, "")
	if pad := width - lipgloss.Width(line); pad > 0 {
		line += strings.Repeat(" ", pad)
	}
	return bg + line + "\x1b[0m"
}
