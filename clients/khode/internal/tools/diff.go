package tools

import (
	"encoding/json"
	"fmt"
	"strings"
)

// diffMaxCells bounds the LCS table; edits beyond it fall back to a
// coarse whole-file diff instead of allocating an enormous table.
const diffMaxCells = 4 << 20

// diffOp is one line of an edit script: equal, removed, or added.
type diffOp struct {
	kind byte // ' ', '-', '+'
	text string
}

// splitLines splits text into lines without their newlines; a trailing
// newline does not produce a trailing empty line.
func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	lines := strings.Split(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// diffOps computes the edit script that turns a into b, line by line,
// via a longest-common subsequence over the changed middle segment.
func diffOps(a, b []string) []diffOp {
	ops := make([]diffOp, 0, len(a)+len(b))
	prefix := 0
	for prefix < len(a) && prefix < len(b) && a[prefix] == b[prefix] {
		prefix++
	}
	suffix := 0
	for suffix < len(a)-prefix && suffix < len(b)-prefix &&
		a[len(a)-1-suffix] == b[len(b)-1-suffix] {
		suffix++
	}
	for _, l := range a[:prefix] {
		ops = append(ops, diffOp{' ', l})
	}
	ops = append(ops, lcsOps(a[prefix:len(a)-suffix], b[prefix:len(b)-suffix])...)
	for _, l := range a[len(a)-suffix:] {
		ops = append(ops, diffOp{' ', l})
	}
	return ops
}

// lcsOps diffs the middle segments left after trimming the common
// prefix and suffix.
func lcsOps(a, b []string) []diffOp {
	switch {
	case len(a) == 0:
		ops := make([]diffOp, len(b))
		for i, l := range b {
			ops[i] = diffOp{'+', l}
		}
		return ops
	case len(b) == 0:
		ops := make([]diffOp, len(a))
		for i, l := range a {
			ops[i] = diffOp{'-', l}
		}
		return ops
	case (len(a)+1)*(len(b)+1) > diffMaxCells:
		// Too big for the table: render every line as changed.
		ops := make([]diffOp, 0, len(a)+len(b))
		for _, l := range a {
			ops = append(ops, diffOp{'-', l})
		}
		for _, l := range b {
			ops = append(ops, diffOp{'+', l})
		}
		return ops
	}

	// lcs[i*(m+1)+j] is the LCS length of a[i:] and b[j:].
	m := len(b) + 1
	lcs := make([]int32, (len(a)+1)*m)
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			switch {
			case a[i] == b[j]:
				lcs[i*m+j] = lcs[(i+1)*m+(j+1)] + 1
			default:
				lcs[i*m+j] = max(lcs[(i+1)*m+j], lcs[i*m+(j+1)])
			}
		}
	}

	var ops []diffOp
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			ops = append(ops, diffOp{' ', a[i]})
			i++
			j++
		case lcs[(i+1)*m+j] >= lcs[i*m+(j+1)]:
			ops = append(ops, diffOp{'-', a[i]})
			i++
		default:
			ops = append(ops, diffOp{'+', b[j]})
			j++
		}
	}
	for ; i < len(a); i++ {
		ops = append(ops, diffOp{'-', a[i]})
	}
	for ; j < len(b); j++ {
		ops = append(ops, diffOp{'+', b[j]})
	}
	return ops
}

// DiffStat summarizes the change between two texts as the number of
// removed and added lines.
func DiffStat(a, b string) (removed, added int) {
	for _, op := range diffOps(splitLines(a), splitLines(b)) {
		switch op.kind {
		case '-':
			removed++
		case '+':
			added++
		}
	}
	return removed, added
}

// UnifiedDiff renders the changes between two texts as unified-style
// hunks with ctx lines of surrounding context; identical texts yield "".
// Hunk headers carry line counts but no file names — the dialog supplies
// its own title.
func UnifiedDiff(a, b string, ctx int) string {
	if a == b {
		return ""
	}
	if ctx < 0 {
		ctx = 0
	}
	ops := diffOps(splitLines(a), splitLines(b))

	// Group the script into hunks: each starts ctx lines before a change
	// and two changes separated by more than 2*ctx equal lines split.
	type hunk struct{ lo, hi int }
	var hunks []hunk
	for i := 0; i < len(ops); {
		if ops[i].kind == ' ' {
			i++
			continue
		}
		start := max(0, i-ctx)
		end, eq := i, 0
		j := i
		for ; j < len(ops); j++ {
			if ops[j].kind == ' ' {
				eq++
				if eq > 2*ctx {
					break
				}
			} else {
				eq = 0
				end = j + 1
			}
		}
		end = min(len(ops), end+ctx)
		if n := len(hunks); n > 0 && start <= hunks[n-1].hi {
			hunks[n-1].hi = end
		} else {
			hunks = append(hunks, hunk{start, end})
		}
		i = j
	}

	var out strings.Builder
	oldLine, newLine := 1, 1
	pos := 0
	for _, h := range hunks {
		for pos < h.lo {
			diffAdvance(ops[pos], &oldLine, &newLine)
			pos++
		}
		oldStart, newStart := oldLine, newLine
		oldCount, newCount := 0, 0
		var lines []string
		for pos < h.hi {
			op := ops[pos]
			diffAdvance(op, &oldLine, &newLine)
			switch op.kind {
			case ' ':
				oldCount++
				newCount++
				lines = append(lines, " "+op.text)
			case '-':
				oldCount++
				lines = append(lines, "-"+op.text)
			case '+':
				newCount++
				lines = append(lines, "+"+op.text)
			}
			pos++
		}
		// A zero-count side is a pure insertion or deletion point; git
		// reports it as the line *after* which the change applies.
		if oldCount == 0 {
			oldStart--
		}
		if newCount == 0 {
			newStart--
		}
		fmt.Fprintf(&out, "@@ -%d,%d +%d,%d @@\n", oldStart, oldCount, newStart, newCount)
		for _, l := range lines {
			out.WriteString(l)
			out.WriteByte('\n')
		}
	}
	return out.String()
}

// diffAdvance moves the old/new line cursors past one edit-script line.
func diffAdvance(op diffOp, oldLine, newLine *int) {
	switch op.kind {
	case ' ':
		*oldLine++
		*newLine++
	case '-':
		*oldLine++
	case '+':
		*newLine++
	}
}

// ChangeDiff renders the unified diff a write-class tool call applies,
// computed from its input alone — no file access, so the result is the
// same live (before or after exec) and when replaying a transcript
// whose file has already changed. edit diffs old_string against
// new_string; write shows its content as pure additions. It returns ""
// for any other tool or unparseable input so callers fall back to the
// plain result line.
func ChangeDiff(name string, input json.RawMessage) string {
	switch name {
	case "edit":
		var a editArgs
		if err := arg(input, &a); err != nil {
			return ""
		}
		return UnifiedDiff(a.OldString, a.NewString, 3)
	case "write":
		var a writeArgs
		if err := arg(input, &a); err != nil {
			return ""
		}
		return UnifiedDiff("", a.Content, 3)
	}
	return ""
}
