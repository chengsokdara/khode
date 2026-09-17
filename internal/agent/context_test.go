package agent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestProjectContextCollectsAncestorsFirst(t *testing.T) {
	root := t.TempDir()
	work := filepath.Join(root, "a", "b")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(dir, name, body string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(root, "AGENTS.md", "root rules")
	write(work, "CLAUDE.md", "leaf rules")

	got := ProjectContext(work)
	rootIdx := strings.Index(got, "root rules")
	leafIdx := strings.Index(got, "leaf rules")
	if rootIdx < 0 || leafIdx < 0 {
		t.Fatalf("ProjectContext = %q, want both root and leaf guidance", got)
	}
	if rootIdx > leafIdx {
		t.Errorf("ancestor guidance must come first:\n%s", got)
	}
	for _, path := range []string{filepath.Join(root, "AGENTS.md"), filepath.Join(work, "CLAUDE.md")} {
		if !strings.Contains(got, path) {
			t.Errorf("missing source path %q in:\n%s", path, got)
		}
	}
}

func TestProjectContextPrefersAgentsMD(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("agents"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "CLAUDE.md"), []byte("claude"), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := ProjectContext(dir); strings.Contains(got, "claude") {
		t.Errorf("AGENTS.md must win over CLAUDE.md at the same level:\n%s", got)
	}
}

func TestProjectContextEmpty(t *testing.T) {
	// A fresh directory deep under root; no ancestor should carry context
	// files in a clean temp tree.
	root := t.TempDir()
	work := filepath.Join(root, "x", "y", "z")
	if err := os.MkdirAll(work, 0o755); err != nil {
		t.Fatal(err)
	}
	if got := ProjectContext(work); got != "" {
		t.Errorf("ProjectContext = %q, want empty", got)
	}
}

func TestProjectContextClippedToCap(t *testing.T) {
	dir := t.TempDir()
	big := strings.Repeat("a", maxContextBytes+1024)
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(big), 0o644); err != nil {
		t.Fatal(err)
	}
	got := ProjectContext(dir)
	if len(got) > maxContextBytes {
		t.Errorf("context is %d bytes, want <= %d", len(got), maxContextBytes)
	}
	if !strings.Contains(got, "truncated") {
		t.Error("clip did not mark the cut")
	}
}

func TestSystemPromptComposesBaseAndContext(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte("always gofmt"), 0o644); err != nil {
		t.Fatal(err)
	}
	got := SystemPrompt(dir)
	if !strings.Contains(got, DefaultSystemPrompt(dir)) {
		t.Error("system prompt lost the base prompt")
	}
	if !strings.Contains(got, "always gofmt") {
		t.Error("system prompt lost the project guidance")
	}

	empty := t.TempDir()
	if got := SystemPrompt(empty); got != DefaultSystemPrompt(empty) {
		t.Error("prompt must equal the base prompt without context files")
	}
}
