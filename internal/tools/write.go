package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// Write creates or completely overwrites one file, making parent
// directories as needed.
type Write struct{ Root string }

type writeArgs struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

func (w *Write) Name() string { return "write" }

func (w *Write) Description() string {
	return "Create a file, or overwrite one entirely with the given content. " +
		"For small changes to an existing file prefer edit. Parent directories " +
		"are created automatically. Relative paths resolve against the project root."
}

func (w *Write) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "path":    {"type": "string", "description": "File path (absolute, or relative to the project root)"},
    "content": {"type": "string", "description": "Full file content to write (overwrites any existing content)"}
  },
  "required": ["path", "content"]
}`)
}

// Exec writes the content and reports how many lines landed on disk.
func (w *Write) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a writeArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Path == "" {
		return "", fmt.Errorf("path is required")
	}
	path := resolve(w.Root, a.Path)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", fmt.Errorf("creating directories for %s: %w", display(w.Root, path), err)
	}
	perm := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		perm = fi.Mode().Perm() // preserve the mode of an overwritten file
	}
	if err := os.WriteFile(path, []byte(a.Content), perm); err != nil {
		return "", fmt.Errorf("writing %s: %w", display(w.Root, path), err)
	}
	if n := countLines(a.Content); n > 0 {
		return fmt.Sprintf("Wrote %s (%s)", display(w.Root, path), pluralLines(n)), nil
	}
	return fmt.Sprintf("Wrote %s (empty file)", display(w.Root, path)), nil
}

// Preview renders the write as a unified diff against the file's current
// content, or as an all-additions diff for a new file.
func (w *Write) Preview(args json.RawMessage) (string, error) {
	var a writeArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Path == "" {
		return "", fmt.Errorf("path is required")
	}
	var old string
	if data, err := os.ReadFile(resolve(w.Root, a.Path)); err == nil {
		old = string(data)
	} else if a.Content == "" {
		return "", nil // writing nothing over nothing: no change to show
	}
	return UnifiedDiff(old, a.Content, 3), nil
}

// countLines counts lines the way an editor status bar does: one per
// newline plus a final partial line.
func countLines(s string) int {
	if s == "" {
		return 0
	}
	n := 1
	for _, b := range []byte(s) {
		if b == '\n' {
			n++
		}
	}
	if n > 1 && s[len(s)-1] == '\n' {
		n--
	}
	return n
}

// pluralLines words a line count for result summaries.
func pluralLines(n int) string {
	if n == 1 {
		return "1 line"
	}
	return fmt.Sprintf("%d lines", n)
}

// interface guards: registry entries must satisfy the tool contract.
var (
	_ Tool      = (*Write)(nil)
	_ Previewer = (*Write)(nil)
)
