package ui

// Syntax highlighting for diff content, VSCode style: the code inside a
// change keeps its language colors while the + / - markers carry the
// add/remove tint. The token palette is aurora — keywords cyan (khode's
// activity color), strings and numbers amber, comments dim, names mint —
// and chroma (already a glamour dependency) does the lexing.

import (
	"bytes"
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

// renderDiffLines styles a unified diff: hunk headers dim, the + / -
// markers green and red, and the code itself syntax-highlighted for the
// file's language. Consecutive lines of one kind lex as a single
// snippet, so multi-line comments and strings survive.
func renderDiffLines(diff, path string, width int) []string {
	lines := strings.Split(strings.TrimRight(diff, "\n"), "\n")
	out := make([]string, 0, len(lines))
	for i := 0; i < len(lines); {
		marker := diffMarker(lines[i])
		j := i + 1
		for j < len(lines) && diffMarker(lines[j]) == marker {
			j++
		}
		switch marker {
		case '@':
			for k := i; k < j; k++ {
				out = append(out, dimStyle.Render(clip(lines[k], width)))
			}
		default:
			code := make([]string, j-i)
			for k := i; k < j; k++ {
				code[k-i] = lines[k][1:]
			}
			hl := highlightLines(strings.Join(code, "\n"), path)
			for k := i; k < j; k++ {
				body := hl[k-i]
				if lipgloss.Width(body) > width {
					body = ansi.Truncate(body, width, "")
				}
				switch marker {
				case '+':
					out = append(out, addStyle.Render("+")+body)
				case '-':
					out = append(out, delStyle.Render("-")+body)
				default:
					out = append(out, " "+body)
				}
			}
		}
		i = j
	}
	return out
}

// diffMarker returns a unified-diff line's kind byte: '@' for hunk
// headers, '+', '-', or ' ' for context. Malformed lines read as
// context so they still render.
func diffMarker(line string) byte {
	if line == "" {
		return ' '
	}
	switch line[0] {
	case '@', '+', '-':
		return line[0]
	}
	return ' '
}
