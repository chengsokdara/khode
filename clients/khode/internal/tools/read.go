package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
)

// Read caps for one call: the defaults keep a reply inside the model's
// window while still covering most source files.
const (
	readDefaultLimit = 1000
	readMaxLimit     = 2000
	readMaxLineLen   = 2000
)

// Read prints a file (optionally a line window) with line numbers.
type Read struct {
	Root string
}

type readArgs struct {
	Path   string `json:"path"`
	Offset int64  `json:"offset"` // 1-based first line
	Limit  int    `json:"limit"`  // lines to show
}

func (r *Read) Name() string { return "read" }

func (r *Read) Description() string {
	return "Read a text file and return it with line numbers. " +
		"Relative paths resolve against the project root. " +
		"Use offset/limit to page through large files."
}

func (r *Read) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "path":   {"type": "string", "description": "File path (absolute, or relative to the project root)"},
    "offset": {"type": "integer", "description": "1-based line number to start reading from (default 1)"},
    "limit":  {"type": "integer", "description": "Maximum lines to return (default 1000, max 2000)"}
  },
  "required": ["path"]
}`)
}

func (r *Read) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a readArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Path == "" {
		return "", fmt.Errorf("path is required")
	}
	path := resolve(r.Root, a.Path)

	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()

	fi, err := f.Stat()
	if err != nil {
		return "", err
	}
	if fi.IsDir() {
		return "", fmt.Errorf("%s is a directory", display(r.Root, path))
	}

	limit := a.Limit
	if limit <= 0 {
		limit = readDefaultLimit
	}
	limit = min(limit, readMaxLimit)

	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)

	out := make([]byte, 0, 32*1024)
	var n, shown int64
	truncated := false
	for sc.Scan() {
		n++
		if n < a.Offset {
			continue
		}
		if shown == int64(limit) {
			truncated = true
			break
		}
		shown++
		out = append(out, fmt.Sprintf("%6d\t", n)...)
		line := sc.Bytes()
		over := false
		if len(line) > readMaxLineLen {
			line = line[:readMaxLineLen]
			over = true
		}
		out = append(out, line...)
		if over {
			out = append(out, " …"...)
		}
		out = append(out, '\n')
	}
	if err := sc.Err(); err != nil {
		return "", fmt.Errorf("reading %s: %w", display(r.Root, path), err)
	}
	if n == 0 {
		return "", fmt.Errorf("%s is empty", display(r.Root, path))
	}
	if shown == 0 {
		return "", fmt.Errorf("offset %d is past the end of %s (%d lines)",
			a.Offset, display(r.Root, path), n)
	}
	if truncated {
		out = append(out, fmt.Sprintf("... (truncated at %d lines; re-read with offset %d to continue)\n",
			limit, a.Offset+int64(limit))...)
	}
	return string(out), nil
}

// interface guard: registry entries must satisfy the tool contract.
var _ Tool = (*Read)(nil)
