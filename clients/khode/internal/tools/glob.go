package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
)

// globMaxFiles caps one call's output so a broad pattern can't flood the
// model's context window.
const globMaxFiles = 1000

// Glob lists files whose path matches a glob pattern. Patterns support
// `**` (any number of directories) on top of standard path.Match syntax,
// which the standard library's filepath.Glob lacks.
type Glob struct {
	Root string
}

type globArgs struct {
	Pattern string `json:"pattern"`
	Path    string `json:"path"` // base directory; defaults to the root
}

func (g *Glob) Name() string { return "glob" }

func (g *Glob) Description() string {
	return "Find files whose path matches a glob pattern, e.g. \"**/*.go\" or \"internal/**/*.md\". " +
		"Supports * (within one directory level), ** (any depth), and ? wildcards. " +
		"Returns matches sorted alphabetically."
}

func (g *Glob) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "pattern": {"type": "string", "description": "Glob pattern relative to path, e.g. **/*.go"},
    "path":    {"type": "string", "description": "Base directory to search (default: project root)"}
  },
  "required": ["pattern"]
}`)
}

func (g *Glob) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a globArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Pattern == "" {
		return "", fmt.Errorf("pattern is required")
	}
	base := resolve(g.Root, a.Path)
	fi, err := os.Stat(base)
	if err != nil {
		return "", err
	}
	if !fi.IsDir() {
		return "", fmt.Errorf("%s is not a directory", display(g.Root, base))
	}

	var matches []string
	err = filepath.WalkDir(base, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		rel, relErr := filepath.Rel(base, p)
		if relErr != nil {
			return relErr
		}
		if d.IsDir() {
			return nil // directories match only when explicitly named
		}
		if matchGlob(a.Pattern, filepath.ToSlash(rel)) {
			matches = append(matches, display(g.Root, p))
		}
		return nil
	})
	if err != nil {
		return "", fmt.Errorf("globbing %s: %w", display(g.Root, base), err)
	}
	if len(matches) == 0 {
		return "no matches", nil
	}
	sort.Strings(matches)
	truncated := len(matches) > globMaxFiles
	if truncated {
		matches = matches[:globMaxFiles]
	}
	out := strings.Join(matches, "\n")
	if truncated {
		out += fmt.Sprintf("\n... (showing first %d matches; narrow the pattern)", globMaxFiles)
	}
	return out, nil
}

// matchGlob reports whether rel (slash-separated) matches pattern. "**"
// spans zero or more whole path segments; every other segment is a
// standard path.Match pattern.
func matchGlob(pattern, rel string) bool {
	return matchSegments(strings.Split(pattern, "/"), strings.Split(rel, "/"))
}

func matchSegments(pattern, segs []string) bool {
	if len(pattern) == 0 {
		return len(segs) == 0
	}
	if pattern[0] == "**" {
		for skip := 0; skip <= len(segs); skip++ {
			if matchSegments(pattern[1:], segs[skip:]) {
				return true
			}
		}
		return false
	}
	if len(segs) == 0 {
		return false
	}
	ok, err := path.Match(pattern[0], segs[0])
	if err != nil || !ok {
		return false
	}
	return matchSegments(pattern[1:], segs[1:])
}

// interface guard: registry entries must satisfy the tool contract.
var _ Tool = (*Glob)(nil)
