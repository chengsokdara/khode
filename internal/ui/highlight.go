package ui

// Syntax highlighting for diff content, Grok style: the code keeps its
// language colors and sits on full-width background bands — dark green
// over additions, dark red over removals — behind a dim line-number
// gutter, with no + / - markers. The token palette is aurora — keywords
// cyan (khode's activity color), strings and numbers amber, comments
// dim, names mint — and chroma (glamour's lexer) does the lexing.

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"

	"charm.land/lipgloss/v2"
	"github.com/alecthomas/chroma/v2"
	"github.com/alecthomas/chroma/v2/formatters"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/charmbracelet/x/ansi"
)

// auroraChroma speaks the aurora palette to chroma's truecolor
// formatter. Entries are Pygments-style descriptors: color plus
// optional bold/italic.
var auroraChroma = chroma.MustNewStyle("khode", chroma.StyleEntries{
	chroma.Text:                "#DCE9E5",
	chroma.Comment:             "#5C6B73 italic",
	chroma.CommentPreproc:      "#5C6B73",
	chroma.Keyword:             "#5EEAD4",
	chroma.KeywordType:         "#5EEAD4",
	chroma.KeywordConstant:     "#5EEAD4",
	chroma.KeywordNamespace:    "#5EEAD4",
	chroma.OperatorWord:        "#5EEAD4",
	chroma.LiteralString:       "#FBBF24",
	chroma.LiteralStringEscape: "#FBBF24 bold",
	chroma.LiteralNumber:       "#FBBF24",
	chroma.NameFunction:        "#5EEAD4 bold",
	chroma.NameClass:           "#99F6E4 bold",
	chroma.NameTag:             "#F87171",
	chroma.NameAttribute:       "#99F6E4",
	chroma.NameBuiltin:         "#2DD4BF",
	chroma.NameDecorator:       "#99F6E4",
	chroma.Punctuation:         "#8FA8A3",
	chroma.Operator:            "#8FA8A3",
	chroma.GenericHeading:      "#5EEAD4 bold",
	chroma.GenericSubheading:   "#99F6E4 bold",
	chroma.GenericDeleted:      "#F87171",
	chroma.GenericInserted:     "#4ADE80",
	chroma.GenericEmph:         "#DCE9E5 italic",
	chroma.GenericStrong:       "#DCE9E5 bold",
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

// bandLine wraps a styled line in a full-width background band — the
// dark green/red rows behind diff lines. Chroma resets exactly once per
// line, so stripping that reset lets the band survive the syntax colors
// on top; the row is padded out to the full width inside the band.
func bandLine(line string, bgHex string, width int) string {
	c, err := parseHex(bgHex)
	if err != nil {
		return line
	}
	bg := fmt.Sprintf("\x1b[48;2;%d;%d;%dm", int(c[0]), int(c[1]), int(c[2]))
	line = strings.TrimSuffix(line, "\x1b[0m")
	if pad := width - lipgloss.Width(line); pad > 0 {
		line += strings.Repeat(" ", pad)
	}
	return bg + line + "\x1b[0m"
}
