package tools

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/perm"
)

// writeTree materializes a small project for the tool tests.
func writeTree(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	files := map[string]string{
		"main.go":             "package main\n\nfunc main() {}\n",
		"internal/llm/llm.go": "package llm\n\n// TODO stream\nvar X = 1\n",
		"internal/ui/ui.go":   "package ui\n\nvar TODO = true\n",
		"docs/readme.md":      "# khode\n\nTODO: write docs\n",
		".hidden/secret.txt":  "hidden TODO\n",
	}
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return root
}

func mustExec(t *testing.T, tool Tool, args string) string {
	t.Helper()
	out, err := tool.Exec(t.Context(), json.RawMessage(args))
	if err != nil {
		t.Fatalf("Exec(%s): %v", args, err)
	}
	return out
}

func TestRegistry(t *testing.T) {
	reg := Default(writeTree(t))
	if got := reg.Names(); len(got) != 6 {
		t.Fatalf("Names() = %v, want 6 tools", got)
	}
	defs := reg.Definitions()
	if len(defs) != 6 || defs[0].Name != "bash" || defs[1].Name != "edit" ||
		defs[2].Name != "glob" || defs[3].Name != "grep" || defs[4].Name != "read" || defs[5].Name != "write" {
		t.Fatalf("Definitions() order wrong: %s/%s/%s/%s/%s/%s",
			defs[0].Name, defs[1].Name, defs[2].Name, defs[3].Name, defs[4].Name, defs[5].Name)
	}
	var schema map[string]any
	if err := json.Unmarshal(defs[4].Parameters, &schema); err != nil {
		t.Fatalf("read schema not valid JSON: %v", err)
	}
	if _, ok := schema["properties"]; !ok {
		t.Errorf("read schema has no properties: %s", defs[4].Parameters)
	}
	if _, ok := reg.Get("nope"); ok {
		t.Error("Get(nope) returned a tool")
	}
}

func TestRegistryRisk(t *testing.T) {
	reg := Default(t.TempDir())
	cases := map[string]perm.Risk{
		"bash": perm.RiskExec, "edit": perm.RiskWrite, "write": perm.RiskWrite,
		"read": perm.RiskRead, "glob": perm.RiskRead, "grep": perm.RiskRead,
		"nope": perm.RiskRead,
	}
	for name, want := range cases {
		if got := reg.RiskOf(name); got != want {
			t.Errorf("RiskOf(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestReadWholeFile(t *testing.T) {
	root := writeTree(t)
	r := &Read{Root: root}

	out := mustExec(t, r, `{"path":"main.go"}`)
	want := "     1\tpackage main\n     2\t\n     3\tfunc main() {}\n"
	if out != want {
		t.Errorf("read output = %q, want %q", out, want)
	}

	if _, err := r.Exec(t.Context(), json.RawMessage(`{"path":"missing.go"}`)); err == nil {
		t.Error("missing file: want error")
	}
	if _, err := r.Exec(t.Context(), json.RawMessage(`{"path":"internal"}`)); err == nil {
		t.Error("directory: want error")
	}
	if _, err := r.Exec(t.Context(), json.RawMessage(`{}`)); err == nil {
		t.Error("no path: want error")
	}
}

func TestReadWindowing(t *testing.T) {
	root := t.TempDir()
	var b strings.Builder
	for i := 1; i <= 50; i++ {
		fmt.Fprintf(&b, "line %d\n", i)
	}
	if err := os.WriteFile(filepath.Join(root, "big.txt"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	r := &Read{Root: root}

	out := mustExec(t, r, `{"path":"big.txt","offset":45,"limit":4}`)
	want := "    45\tline 45\n    46\tline 46\n    47\tline 47\n    48\tline 48\n" +
		"... (truncated at 4 lines; re-read with offset 49 to continue)\n"
	if out != want {
		t.Errorf("windowed read = %q, want %q", out, want)
	}

	if _, err := r.Exec(t.Context(), json.RawMessage(`{"path":"big.txt","offset":99}`)); err == nil {
		t.Error("offset past EOF: want error")
	}

	// Lines beyond the length cap are cut with an ellipsis marker.
	long := strings.Repeat("x", readMaxLineLen+100)
	if err := os.WriteFile(filepath.Join(root, "long.txt"), []byte(long+"\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	out = mustExec(t, r, `{"path":"long.txt"}`)
	if !strings.HasSuffix(out, " …\n") || len(out) > readMaxLineLen+16 {
		t.Errorf("long line not truncated: len=%d suffix=%q", len(out), out[max(0, len(out)-8):])
	}
}

func TestGlob(t *testing.T) {
	root := writeTree(t)
	g := &Glob{Root: root}

	out := mustExec(t, g, `{"pattern":"**/*.go"}`)
	want := "internal/llm/llm.go\ninternal/ui/ui.go\nmain.go"
	if out != want {
		t.Errorf("glob **/*.go = %q, want %q", out, want)
	}

	out = mustExec(t, g, `{"pattern":"*.go"}`)
	if out != "main.go" {
		t.Errorf("glob *.go = %q, want main.go only", out)
	}

	out = mustExec(t, g, `{"pattern":"**/ui.*"}`)
	if out != "internal/ui/ui.go" {
		t.Errorf("glob **/ui.* = %q", out)
	}

	out = mustExec(t, g, `{"pattern":"**/*.md","path":"docs"}`)
	if out != "docs/readme.md" {
		t.Errorf("glob in docs = %q", out)
	}

	if out := mustExec(t, g, `{"pattern":"**/*.rs"}`); out != "no matches" {
		t.Errorf("glob no match = %q", out)
	}
	if _, err := g.Exec(t.Context(), json.RawMessage(`{"pattern":"**"}`)); err != nil {
		// `**` alone matches everything, including dotfiles; only errors matter.
		t.Errorf("bare ** should not error: %v", err)
	}
}

func TestGlobSegments(t *testing.T) {
	cases := []struct {
		pattern, rel string
		want         bool
	}{
		{"*.go", "main.go", true},
		{"*.go", "a/main.go", false},
		{"**/*.go", "a/b/c.go", true},
		{"**/*.go", "c.go", true}, // ** spans zero dirs
		{"a/**/*.go", "a/b/c.go", true},
		{"a/**/*.go", "b/c.go", false},
		{"**", "x/y.go", true},
		{"internal/*", "internal/llm", true},       // * matches one whole segment
		{"internal/*", "internal/llm/x.go", false}, // * does not cross separators
		{"internal/**/*.go", "internal/llm/x.go", true},
		{"?.go", "a.go", true},
		{"?.go", "ab.go", false},
	}
	for _, c := range cases {
		if got := matchGlob(c.pattern, c.rel); got != c.want {
			t.Errorf("matchGlob(%q, %q) = %v, want %v", c.pattern, c.rel, got, c.want)
		}
	}
}

func TestGrep(t *testing.T) {
	root := writeTree(t)
	g := &Grep{Root: root}

	out := mustExec(t, g, `{"pattern":"TODO"}`)
	want := "docs/readme.md:3:TODO: write docs\n" +
		"internal/llm/llm.go:3:// TODO stream\n" +
		"internal/ui/ui.go:3:var TODO = true\n"
	if out != want {
		t.Errorf("grep TODO = %q, want %q", out, want)
	}

	out = mustExec(t, g, `{"pattern":"TODO","include":"*.md"}`)
	if out != "docs/readme.md:3:TODO: write docs\n" {
		t.Errorf("grep TODO *.md = %q", out)
	}

	out = mustExec(t, g, `{"pattern":"TODO","path":"docs"}`)
	if out != "docs/readme.md:3:TODO: write docs\n" {
		t.Errorf("grep TODO in docs = %q", out)
	}

	// Regex features work.
	out = mustExec(t, g, `{"pattern":"var X = \\d"}`)
	if out != "internal/llm/llm.go:4:var X = 1\n" {
		t.Errorf("grep regex = %q", out)
	}

	if out := mustExec(t, g, `{"pattern":"nomatchxyz"}`); out != "no matches" {
		t.Errorf("grep no match = %q", out)
	}
	if _, err := g.Exec(t.Context(), json.RawMessage(`{"pattern":"("}`)); err == nil {
		t.Error("invalid regex: want error")
	}
	if _, err := g.Exec(t.Context(), json.RawMessage(`{"pattern":"x","path":"missing"}`)); err == nil {
		t.Error("missing path: want error")
	}
}

func TestGrepSkipsBinaryAndGit(t *testing.T) {
	root := t.TempDir()
	bin := []byte("hello\x00world needle\n")
	if err := os.WriteFile(filepath.Join(root, "blob.bin"), bin, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".git", "packed"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "text.txt"), []byte("needle\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	out := mustExec(t, &Grep{Root: root}, `{"pattern":"needle"}`)
	if out != "text.txt:1:needle\n" {
		t.Errorf("grep = %q, want only text.txt", out)
	}
}

func TestGrepCap(t *testing.T) {
	root := t.TempDir()
	var b strings.Builder
	for i := 0; i < grepMaxMatches+50; i++ {
		fmt.Fprintf(&b, "hit %d\n", i)
	}
	if err := os.WriteFile(filepath.Join(root, "many.txt"), []byte(b.String()), 0o644); err != nil {
		t.Fatal(err)
	}
	out := mustExec(t, &Grep{Root: root}, `{"pattern":"hit"}`)
	lines := strings.Count(out, "\n")
	if lines != grepMaxMatches+1 { // matches + truncation note
		t.Errorf("got %d output lines, want %d", lines, grepMaxMatches+1)
	}
	if !strings.Contains(out, "refine the pattern") {
		t.Error("truncation note missing")
	}
}

func TestResolveAndDisplay(t *testing.T) {
	root := "/tmp/proj"
	if got := resolve(root, "a/b.go"); got != filepath.Join(root, "a/b.go") {
		t.Errorf("resolve relative = %q", got)
	}
	if got := resolve(root, "/abs/x"); got != "/abs/x" {
		t.Errorf("resolve absolute = %q", got)
	}
	if got := resolve(root, ""); got != root {
		t.Errorf("resolve empty = %q", got)
	}
	if got := display(root, filepath.Join(root, "a.go")); got != "a.go" {
		t.Errorf("display under root = %q", got)
	}
	if got := display(root, "/elsewhere/a.go"); got != "/elsewhere/a.go" {
		t.Errorf("display outside root = %q", got)
	}
}
