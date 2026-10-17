package agent

import (
	"os"
	"path/filepath"
	"strings"
)

// Project-context injection: AGENTS.md / CLAUDE.md files around the
// working directory become part of the system prompt, so the model sees
// the same per-repo guidance a human's coding agent does.

// maxContextBytes caps total injected project context so a huge AGENTS.md
// cannot crowd out the model's context window.
const maxContextBytes = 16 << 10

// projectFiles lists the context file names checked at each directory
// level; the first one present wins for that level.
var projectFiles = []string{"AGENTS.md", "CLAUDE.md"}

// ProjectContext collects project guidance for workdir: at every level
// from the filesystem root down to workdir, the first of projectFiles
// found is included, ancestors first. Directories without a context file
// contribute nothing; the result is capped at maxContextBytes and empty
// when no file exists.
func ProjectContext(workdir string) string {
	abs, err := filepath.Abs(workdir)
	if err != nil {
		return ""
	}

	var b strings.Builder
	for _, dir := range ancestors(abs) {
		for _, name := range projectFiles {
			data, err := os.ReadFile(filepath.Join(dir, name))
			if err != nil {
				continue
			}
			if b.Len() > 0 {
				b.WriteString("\n\n")
			}
			b.WriteString("#### From " + filepath.Join(dir, name) + "\n\n")
			b.Write(clip(data, maxContextBytes-b.Len()))
			break
		}
		if b.Len() >= maxContextBytes {
			break
		}
	}
	return strings.TrimSpace(b.String())
}

// ancestors lists path and every parent up to the filesystem root,
// topmost first.
func ancestors(path string) []string {
	var dirs []string
	for {
		dirs = append(dirs, path)
		parent := filepath.Dir(path)
		if parent == path {
			break
		}
		path = parent
	}
	for i, j := 0, len(dirs)-1; i < j; i, j = i+1, j-1 {
		dirs[i], dirs[j] = dirs[j], dirs[i]
	}
	return dirs
}

// clip cuts data to at most n bytes, marking a cut with a note.
func clip(data []byte, n int) []byte {
	if n <= 0 {
		return nil
	}
	const marker = "\n\n(…truncated)\n"
	if len(data) <= n {
		return data
	}
	return append(data[:max(0, n-len(marker))], []byte(marker)...)
}

// SystemPrompt builds the system prompt for a turn: khode's base prompt
// plus project guidance from AGENTS.md/CLAUDE.md when the project has
// any. Context is re-read every turn, so edits apply to the next message.
func SystemPrompt(workdir string) string {
	base := DefaultSystemPrompt(workdir)
	if ctx := ProjectContext(workdir); ctx != "" {
		base += "\n\n# Project guidance\n\nThe project provides the following guidance for coding agents; follow it.\n\n" + ctx
	}
	return base
}
