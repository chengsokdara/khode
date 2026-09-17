package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// Edit replaces an exact string in a file; the match must be unique
// unless replace_all is set.
type Edit struct{ Root string }

type editArgs struct {
	Path       string `json:"path"`
	OldString  string `json:"old_string"`
	NewString  string `json:"new_string"`
	ReplaceAll bool   `json:"replace_all"`
}

func (e *Edit) Name() string { return "edit" }

func (e *Edit) Description() string {
	return "Replace an exact string in an existing file. old_string must match " +
		"byte-for-byte and appear exactly once unless replace_all is true; include " +
		"surrounding lines to disambiguate. Relative paths resolve against the project root."
}

func (e *Edit) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "path":        {"type": "string", "description": "File path (absolute, or relative to the project root)"},
    "old_string":  {"type": "string", "description": "Exact text to replace, copied from the current file content"},
    "new_string":  {"type": "string", "description": "Replacement text (may be empty to delete the matched text)"},
    "replace_all": {"type": "boolean", "description": "Replace every occurrence instead of requiring a unique match (default false)"}
  },
  "required": ["path", "old_string", "new_string"]
}`)
}

// Exec applies the replacement and reports the line-level change.
func (e *Edit) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a editArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	path, old, updated, matches, err := e.compute(a)
	if err != nil {
		return "", err
	}
	perm := os.FileMode(0o644)
	if fi, err := os.Stat(path); err == nil {
		perm = fi.Mode().Perm()
	}
	if err := os.WriteFile(path, []byte(updated), perm); err != nil {
		return "", fmt.Errorf("writing %s: %w", display(e.Root, path), err)
	}
	del, add := DiffStat(old, updated)
	return fmt.Sprintf("Edited %s (%s, +%d −%d lines)",
		display(e.Root, path), occurrences(matches), add, del), nil
}

// Preview renders the change as a unified diff without writing anything.
func (e *Edit) Preview(args json.RawMessage) (string, error) {
	var a editArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	_, old, updated, _, err := e.compute(a)
	if err != nil {
		return "", err
	}
	return UnifiedDiff(old, updated, 3), nil
}

// compute validates the arguments and reads the file, returning the
// current content, the content after replacement, and the match count.
// It only reads; Exec performs the write.
func (e *Edit) compute(a editArgs) (path, old, updated string, matches int, err error) {
	switch {
	case a.Path == "":
		return "", "", "", 0, fmt.Errorf("path is required")
	case a.OldString == "":
		return "", "", "", 0, fmt.Errorf("old_string is required (use write to create a new file)")
	case a.OldString == a.NewString:
		return "", "", "", 0, fmt.Errorf("old_string and new_string are identical")
	}
	path = resolve(e.Root, a.Path)
	data, err := os.ReadFile(path)
	if err != nil {
		return "", "", "", 0, err
	}
	old = string(data)
	matches = strings.Count(old, a.OldString)
	switch {
	case matches == 0:
		return "", "", "", 0, fmt.Errorf(
			"old_string not found in %s — read the file first; the match is byte-for-byte",
			display(e.Root, path))
	case matches > 1 && !a.ReplaceAll:
		return "", "", "", 0, fmt.Errorf(
			"old_string matches %d locations in %s — add surrounding lines to make it unique, or set replace_all",
			matches, display(e.Root, path))
	}
	updated = strings.ReplaceAll(old, a.OldString, a.NewString)
	return path, old, updated, matches, nil
}

// occurrences words the match count for the result summary.
func occurrences(n int) string {
	if n == 1 {
		return "1 occurrence"
	}
	return fmt.Sprintf("%d occurrences", n)
}

// interface guards: registry entries must satisfy the tool contract.
var (
	_ Tool      = (*Edit)(nil)
	_ Previewer = (*Edit)(nil)
)
