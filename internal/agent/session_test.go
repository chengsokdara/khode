package agent

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"khode/internal/llm"
)

func writeSession(t *testing.T, dir, name string, msgs ...llm.Message) *Session {
	t.Helper()
	s, err := NewSessionNamed(dir, name)
	if err != nil {
		t.Fatalf("NewSessionNamed(%q): %v", name, err)
	}
	for _, m := range msgs {
		if err := s.Append(m); err != nil {
			t.Fatalf("Append: %v", err)
		}
	}
	return s
}

func TestSessionRoundTrip(t *testing.T) {
	dir := t.TempDir()
	writeSession(t, dir, "20260101-000000",
		llm.Message{Role: llm.RoleUser, Content: "hi"},
		llm.Message{Role: llm.RoleAssistant, Content: "hello"},
	)

	loaded, err := LoadLatest(dir)
	if err != nil {
		t.Fatalf("LoadLatest: %v", err)
	}
	got := loaded.Messages()
	if len(got) != 2 || got[0].Content != "hi" || got[1].Content != "hello" {
		t.Errorf("round trip = %v, want [hi hello]", got)
	}
	if got[0].Role != llm.RoleUser || got[1].Role != llm.RoleAssistant {
		t.Errorf("roles = %v %v, want user assistant", got[0].Role, got[1].Role)
	}
}

func TestNewSessionNamed(t *testing.T) {
	dir := t.TempDir()

	s, err := NewSessionNamed(dir, "My Topic!")
	if err != nil {
		t.Fatalf("NewSessionNamed: %v", err)
	}
	if want := "my-topic.jsonl"; filepath.Base(s.Path) != want {
		t.Errorf("file = %q, want %q", filepath.Base(s.Path), want)
	}
	if s.Name() != "my-topic" {
		t.Errorf("Name() = %q, want my-topic", s.Name())
	}

	// An existing name is never overwritten.
	if _, err := NewSessionNamed(dir, "my topic"); !errors.Is(err, ErrSessionExists) {
		t.Errorf("duplicate name err = %v, want ErrSessionExists", err)
	}

	// Punctuation-only names are rejected, not turned into junk files.
	if _, err := NewSessionNamed(dir, "???"); err == nil {
		t.Error("junk name accepted")
	}
}

func TestSlugify(t *testing.T) {
	tests := map[string]string{
		"Fix the login bug": "fix-the-login-bug",
		"  spaced  out  ":   "spaced-out",
		"UPPER_case-9":      "upper_case-9",
		"!!!":               "",
		"a!!!b":             "a-b",
	}
	for in, want := range tests {
		if got := slugify(in); got != want {
			t.Errorf("slugify(%q) = %q, want %q", in, got, want)
		}
	}
	long := slugify(strings.Repeat("x", 200))
	if len(long) > maxNameLen {
		t.Errorf("slug len = %d, want <= %d", len(long), maxNameLen)
	}
}

func TestLoadSessionsNewestFirstSkipsEmpty(t *testing.T) {
	dir := t.TempDir()

	empty := filepath.Join(dir, "2026-01-01-000000.jsonl")
	if err := os.WriteFile(empty, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	writeSession(t, dir, "old-topic",
		llm.Message{Role: llm.RoleUser, Content: "earlier"})
	writeSession(t, dir, "new-topic",
		llm.Message{Role: llm.RoleUser, Content: "later"})

	// Make the intended order explicit; mtime granularity varies by FS.
	base := time.Now().Add(-time.Hour)
	setModTime := func(name string, d time.Duration) {
		path := filepath.Join(dir, name+".jsonl")
		if err := os.Chtimes(path, base.Add(d), base.Add(d)); err != nil {
			t.Fatal(err)
		}
	}
	setModTime("old-topic", 0)
	setModTime("new-topic", time.Minute)

	infos, err := LoadSessions(dir)
	if err != nil {
		t.Fatalf("LoadSessions: %v", err)
	}
	if len(infos) != 2 {
		t.Fatalf("got %d sessions, want 2 (empty skipped)", len(infos))
	}
	if infos[0].Name != "new-topic" || infos[1].Name != "old-topic" {
		t.Errorf("order = %s, %s; want new-topic first", infos[0].Name, infos[1].Name)
	}
	if infos[1].Messages != 1 {
		t.Errorf("Messages = %d, want 1", infos[1].Messages)
	}

	// LoadLatest follows mtime, not lexical name order — named sessions
	// must be able to beat timestamped ones.
	latest, err := LoadLatest(dir)
	if err != nil {
		t.Fatalf("LoadLatest: %v", err)
	}
	if latest.Name() != "new-topic" {
		t.Errorf("LoadLatest = %q, want new-topic", latest.Name())
	}
}

func TestLoadByName(t *testing.T) {
	dir := t.TempDir()
	writeSession(t, dir, "fix-login-bug",
		llm.Message{Role: llm.RoleUser, Content: "a"})
	writeSession(t, dir, "fix-logout-bug",
		llm.Message{Role: llm.RoleUser, Content: "b"})
	writeSession(t, dir, "2026-09-16-101010",
		llm.Message{Role: llm.RoleUser, Content: "c"})

	// Exact match, case-insensitive.
	s, err := LoadByName(dir, "FIX-LOGIN-BUG")
	if err != nil || s.Name() != "fix-login-bug" {
		t.Errorf("exact match = %q, %v", s.Name(), err)
	}

	// An ambiguous prefix refuses to guess and lists the candidates.
	s, err = LoadByName(dir, "fix-log")
	if err == nil {
		t.Errorf("ambiguous prefix accepted: %q", s.Name())
	} else if got := err.Error(); !strings.Contains(got, "fix-login-bug") || !strings.Contains(got, "fix-logout-bug") {
		t.Errorf("ambiguity error lists candidates, got: %v", err)
	}

	// A prefix that narrows to one session resolves.
	s, err = LoadByName(dir, "fix-login")
	if err != nil || s.Name() != "fix-login-bug" {
		t.Errorf("unique prefix = %q, %v", s.Name(), err)
	}

	// No match at all.
	if _, err := LoadByName(dir, "nope"); err == nil || strings.Contains(err.Error(), "ambiguous") {
		t.Errorf("missing name err = %v", err)
	}
}
