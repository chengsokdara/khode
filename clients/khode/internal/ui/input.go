package ui

// input.go — chat-input behavior beyond plain typing: the ↑/↓ recall
// buffer (shell-style prompt history) and click-to-cursor mapping for
// the textarea, which has no mouse support of its own.

import (
	"strings"
	"unicode"

	rw "github.com/mattn/go-runewidth"
	"github.com/rivo/uniseg"

	"khode/internal/llm"
)

// maxInputHistory caps the recall buffer; older entries fall off the
// front, newest stay at hand.
const maxInputHistory = 1000

// seedInputHistory rebuilds the recall buffer from a (re)loaded
// transcript, so --resume and session switches recall the prompts that
// session actually sent. Navigation state resets with the buffer.
func (m *Model) seedInputHistory(msgs []llm.Message) {
	hist := make([]string, 0, len(msgs))
	for _, msg := range msgs {
		if msg.Role != llm.RoleUser {
			continue
		}
		input := strings.TrimSpace(msg.Content)
		if input == "" || (len(hist) > 0 && hist[len(hist)-1] == input) {
			continue
		}
		hist = append(hist, input)
	}
	m.inputHistory = hist
	m.inputPos = len(hist)
	m.inputDraft = ""
}

// rememberInput banks a submitted prompt and re-arms navigation for the
// next ↑. Consecutive duplicates collapse, the way shells keep an
// arrow-key spam from filling the buffer with one entry.
func (m *Model) rememberInput(input string) {
	if len(m.inputHistory) == 0 || m.inputHistory[len(m.inputHistory)-1] != input {
		m.inputHistory = append(m.inputHistory, input)
		if len(m.inputHistory) > maxInputHistory {
			m.inputHistory = m.inputHistory[len(m.inputHistory)-maxInputHistory:]
		}
	}
	m.inputPos = len(m.inputHistory)
	m.inputDraft = ""
}

// inputHistoryUp recalls the previous prompt, but only when the cursor
// already rests on the input's first line (soft-wrap aware) — on any
// other line ↑ stays a cursor move inside a multi-line draft. Reports
// whether the key was consumed.
func (m *Model) inputHistoryUp() bool {
	if len(m.inputHistory) == 0 || m.inputPos == 0 {
		return false
	}
	if m.textarea.Line() != 0 || m.textarea.LineInfo().RowOffset != 0 {
		return false
	}
	if m.inputPos == len(m.inputHistory) {
		m.inputDraft = m.textarea.Value()
	}
	m.inputPos--
	m.loadHistoryEntry(m.inputHistory[m.inputPos])
	return true
}

// inputHistoryDown steps forward through the recall buffer when the
// cursor rests on the input's last line; stepping past the newest entry
// restores the draft that was typed before ↑ interrupted it.
func (m *Model) inputHistoryDown() bool {
	if m.inputPos >= len(m.inputHistory) {
		return false
	}
	li := m.textarea.LineInfo()
	if m.textarea.Line() != m.textarea.LineCount()-1 || li.RowOffset != li.Height-1 {
		return false
	}
	m.inputPos++
	if m.inputPos == len(m.inputHistory) {
		m.loadHistoryEntry(m.inputDraft)
	} else {
		m.loadHistoryEntry(m.inputHistory[m.inputPos])
	}
	return true
}

// loadHistoryEntry swaps the input's contents for a recalled prompt,
// cursor parked at the end the way shells leave it.
func (m *Model) loadHistoryEntry(entry string) {
	m.textarea.SetValue(entry)
	m.textarea.MoveToEnd()
	m.syncPopup()
}

// placeInputCursor moves the textarea cursor to a click inside the
// input box: viewRow counts visible rows from the top of the textarea
// view (0 = first) and col counts display columns after the prompt.
// The textarea has no mouse support, so this walks the same soft-wrap
// grid the renderer draws and lands the cursor on the pressed rune.
func (m *Model) placeInputCursor(viewRow, col int) {
	if viewRow < 0 {
		viewRow = 0
	}
	gridRow := viewRow + m.textarea.ScrollYOffset()
	line, runeCol := hitToCursor(m.textarea.Value(), m.textarea.Width(), gridRow, col)
	if m.textarea.Line() != line {
		m.textarea.MoveToEnd()
		for m.textarea.Line() > line {
			m.textarea.CursorUp()
		}
	}
	m.textarea.SetCursorColumn(runeCol)
}

// hitToCursor maps a position in the soft-wrapped view — gridRow over
// all visual rows of the value, col display columns into that row —
// back to a logical line and rune column for the cursor. Columns past
// a row's real runes (the wrap renderer repeats a trailing space at the
// row's end) and rows past the text clamp to the end of their line, so
// clicking empty space parks the cursor at the end of the text.
func hitToCursor(value string, width, gridRow, col int) (line, runeCol int) {
	lines := strings.Split(value, "\n")
	if width <= 0 {
		width = 1
	}
	visual := 0
	for i, l := range lines {
		runes := []rune(l)
		segs := wrapRunes(runes, width)
		if gridRow < visual+len(segs) {
			// Runes in earlier rows of this line all precede the click.
			base := 0
			for _, prev := range segs[:gridRow-visual] {
				base += len(prev)
			}
			walked := 0
			for _, r := range segs[gridRow-visual] {
				w := rw.RuneWidth(r)
				if walked+w > col {
					break
				}
				walked += w
				runeCol++
			}
			return i, min(base+runeCol, len(runes))
		}
		visual += len(segs)
	}
	// Below the last visual row: the very end of the text.
	last := len(lines) - 1
	return last, len([]rune(lines[last]))
}

// wrapRunes folds one logical line into visual rows at the given
// display width. It mirrors bubbles' textarea wrap column for column
// (charm.land/bubbles/v2 v2.2.1, textarea/textarea.go wrap) — clicks
// can only land where the text renders, so the two must never drift.
// Re-check the mirror when upgrading bubbles.
func wrapRunes(runes []rune, width int) [][]rune {
	var (
		lines  = [][]rune{{}}
		word   = []rune{}
		row    int
		spaces int
	)
	for _, r := range runes {
		if unicode.IsSpace(r) {
			spaces++
		} else {
			word = append(word, r)
		}

		if spaces > 0 {
			if uniseg.StringWidth(string(lines[row]))+uniseg.StringWidth(string(word))+spaces > width {
				row++
				lines = append(lines, []rune{})
				lines[row] = append(lines[row], word...)
				lines[row] = append(lines[row], repeatSpaces(spaces)...)
				spaces = 0
				word = nil
			} else {
				lines[row] = append(lines[row], word...)
				lines[row] = append(lines[row], repeatSpaces(spaces)...)
				spaces = 0
				word = nil
			}
		} else {
			// A double-width last rune may not fit this row by itself;
			// move the word down when it overflows.
			lastCharLen := rw.RuneWidth(word[len(word)-1])
			if uniseg.StringWidth(string(word))+lastCharLen > width {
				if len(lines[row]) > 0 {
					row++
					lines = append(lines, []rune{})
				}
				lines[row] = append(lines[row], word...)
				word = nil
			}
		}
	}
	if uniseg.StringWidth(string(lines[row]))+uniseg.StringWidth(string(word))+spaces >= width {
		lines = append(lines, []rune{})
		lines[row+1] = append(lines[row+1], word...)
		// The wrap renderer treats every soft-wrapped row as if it ends
		// in a space, so navigation stays consistent; the extra space
		// here repeats that fiction.
		spaces++
		lines[row+1] = append(lines[row+1], repeatSpaces(spaces)...)
	} else {
		lines[row] = append(lines[row], word...)
		spaces++
		lines[row] = append(lines[row], repeatSpaces(spaces)...)
	}
	return lines
}

func repeatSpaces(n int) []rune {
	return []rune(strings.Repeat(string(' '), n))
}
