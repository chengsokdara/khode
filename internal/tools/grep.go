package tools

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// grepCaps bound one call: 200 matches / 20 KiB keeps output well inside
// the model's window even on a runaway pattern.
const (
	grepMaxMatches  = 200
	grepMaxOutput   = 20 * 1024
	grepSkipDirName = ".git"
)

// Grep searches file contents with a regular expression, printing
// path:line:text for every match.
type Grep struct {
	Root string
}

type grepArgs struct {
	Pattern string `json:"pattern"` // Go regexp syntax
	Path    string `json:"path"`    // file or directory; defaults to the root
	Include string `json:"include"` // filename glob, e.g. "*.go"
}

func (g *Grep) Name() string { return "grep" }

func (g *Grep) Description() string {
	return "Search file contents with a regular expression and print path:line:text for each match. " +
		"Searches the given directory recursively (project root by default); " +
		"optionally restrict files with an include glob like \"*.go\"."
}

func (g *Grep) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "pattern": {"type": "string", "description": "Regular expression (Go regexp syntax)"},
    "path":    {"type": "string", "description": "File or directory to search (default: project root)"},
    "include": {"type": "string", "description": "Only search files whose name matches this glob, e.g. *.go"}
  },
  "required": ["pattern"]
}`)
}

func (g *Grep) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a grepArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Pattern == "" {
		return "", fmt.Errorf("pattern is required")
	}
	re, err := regexp.Compile(a.Pattern)
	if err != nil {
		return "", fmt.Errorf("invalid pattern: %w", err)
	}
	target := resolve(g.Root, a.Path)
	fi, err := os.Stat(target)
	if err != nil {
		return "", err
	}

	var out strings.Builder
	matches := 0
	truncated := false

	search := func(path string, rel string) error {
		if a.Include != "" {
			ok, err := filepath.Match(a.Include, filepath.Base(path))
			if err != nil || !ok {
				return nil
			}
		}
		if isBinary(path) {
			return nil
		}
		f, err := os.Open(path)
		if err != nil {
			return nil // unreadable file: skip, don't fail the search
		}
		defer f.Close()

		sc := bufio.NewScanner(f)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for n := 1; sc.Scan(); n++ {
			if err := ctx.Err(); err != nil {
				return err
			}
			if !re.Match(sc.Bytes()) {
				continue
			}
			if matches == grepMaxMatches || out.Len() >= grepMaxOutput {
				truncated = true
				return fs.SkipAll
			}
			matches++
			fmt.Fprintf(&out, "%s:%d:%s\n", rel, n, strings.TrimSpace(sc.Text()))
		}
		return nil
	}

	if fi.IsDir() {
		err = filepath.WalkDir(target, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			if d.IsDir() {
				// VCS internals and hidden trees are noise, not search
				// targets; an explicit path still searches a hidden dir.
				if p != target && (d.Name() == grepSkipDirName || strings.HasPrefix(d.Name(), ".")) {
					return filepath.SkipDir
				}
				return nil
			}
			return search(p, display(g.Root, p))
		})
	} else {
		err = search(target, display(g.Root, target))
	}
	if err != nil && !errors.Is(err, fs.SkipAll) {
		return "", fmt.Errorf("searching %s: %w", display(g.Root, target), err)
	}
	if matches == 0 {
		return "no matches", nil
	}
	result := out.String()
	if truncated {
		result += fmt.Sprintf("... (stopped at %d matches; refine the pattern)\n", matches)
	}
	return result, nil
}

// isBinary reports whether a file starts with a NUL byte, the usual
// telltale for binaries; probe reads are capped at 512 bytes.
func isBinary(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var probe [512]byte
	n, err := f.Read(probe[:])
	if err != nil && n == 0 {
		return false
	}
	return bytes.IndexByte(probe[:n], 0) >= 0
}

// interface guard: registry entries must satisfy the tool contract.
var _ Tool = (*Grep)(nil)
