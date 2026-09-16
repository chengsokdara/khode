// Package agent holds the conversation machinery: session transcripts and
// (in later phases) the agentic tool loop.
package agent

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"khode/internal/llm"
)

// ErrNoSessions is returned when the sessions directory has no transcripts.
var ErrNoSessions = errors.New("no sessions found")

// line is the on-disk JSONL schema for one message.
type line struct {
	TS      string   `json:"ts"`
	Role    llm.Role `json:"role"`
	Content string   `json:"content"`
}

// Session is an append-only JSONL transcript of a conversation. It is the
// source of truth for what gets sent back to the LLM on every turn.
type Session struct {
	Path string
	msgs []llm.Message
}

// NewSession creates a timestamped transcript file in dir.
func NewSession(dir string) (*Session, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, time.Now().Format("2006-01-02-150405")+".jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Session{Path: path}, f.Close()
}

// LoadLatest resumes the most recent session in dir (filenames are
// timestamped, so lexical order is chronological).
func LoadLatest(dir string) (*Session, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".jsonl" {
			files = append(files, e.Name())
		}
	}
	if len(files) == 0 {
		return nil, ErrNoSessions
	}
	// Sort descending: newest timestamp first.
	for i := 0; i < len(files); i++ {
		for j := i + 1; j < len(files); j++ {
			if files[j] > files[i] {
				files[i], files[j] = files[j], files[i]
			}
		}
	}
	s := &Session{Path: filepath.Join(dir, files[0])}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Session) load() error {
	f, err := os.Open(s.Path)
	if err != nil {
		return err
	}
	defer f.Close()

	sc := bufio.NewScanner(f)
	for sc.Scan() {
		var l line
		if err := json.Unmarshal(sc.Bytes(), &l); err != nil {
			return fmt.Errorf("corrupt session %s: %w", s.Path, err)
		}
		s.msgs = append(s.msgs, llm.Message{Role: l.Role, Content: l.Content})
	}
	return sc.Err()
}

// Append records a turn and persists it immediately (crash-safe-ish).
func (s *Session) Append(m llm.Message) error {
	s.msgs = append(s.msgs, m)

	f, err := os.OpenFile(s.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()

	data, err := json.Marshal(line{
		TS:      time.Now().UTC().Format(time.RFC3339),
		Role:    m.Role,
		Content: m.Content,
	})
	if err != nil {
		return err
	}
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

// Messages returns the full conversation history.
func (s *Session) Messages() []llm.Message { return s.msgs }

// Base returns the transcript file name (shown in the header).
func (s *Session) Base() string { return filepath.Base(s.Path) }
