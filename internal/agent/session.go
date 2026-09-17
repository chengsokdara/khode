// Package agent holds the conversation machinery: session transcripts and
// (in later phases) the agentic tool loop.
package agent

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"khode/internal/llm"
)

// ErrNoSessions is returned when the sessions directory has no usable
// transcripts.
var ErrNoSessions = errors.New("no sessions found")

// ErrSessionExists is returned when creating a named session whose
// transcript already exists.
var ErrSessionExists = errors.New("session already exists")

// maxNameLen caps session-name slugs so they stay readable in the picker.
const maxNameLen = 64

// line is the on-disk JSONL schema for one message. Tool calls and results
// are additive fields; older transcripts without them load unchanged.
type line struct {
	TS         string          `json:"ts"`
	Role       llm.Role        `json:"role"`
	Content    string          `json:"content"`
	ToolCalls  []llm.ToolCall  `json:"tool_calls,omitempty"`
	ToolResult *llm.ToolResult `json:"tool_result,omitempty"`
}

// Session is an append-only JSONL transcript of a conversation. It is the
// source of truth for what gets sent back to the LLM on every turn.
type Session struct {
	Path string
	msgs []llm.Message
}

// Info describes one stored transcript, for the session picker.
type Info struct {
	Name     string    // file name without the .jsonl suffix
	Path     string    // full path, for Open
	ModTime  time.Time // last write, drives "newest first"
	Messages int       // transcript line count
}

// NewMemorySession returns a session that lives only in memory: nothing
// is ever written to disk. Subagent transcripts use it — their history
// is scratch work the parent never replays.
func NewMemorySession() *Session { return &Session{} }

// NewSession creates a timestamped transcript file in dir.
func NewSession(dir string) (*Session, error) {
	return create(dir, time.Now().Format("2006-01-02-150405"))
}

// NewSessionNamed creates a transcript named after a user-chosen topic.
// The name is slugified for filesystem safety; an existing session of the
// same name is never overwritten.
func NewSessionNamed(dir, name string) (*Session, error) {
	slug := slugify(name)
	if slug == "" {
		return nil, fmt.Errorf("invalid session name %q", name)
	}
	path := filepath.Join(dir, slug+".jsonl")
	if _, err := os.Stat(path); err == nil {
		return nil, fmt.Errorf("%w: %s", ErrSessionExists, slug)
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	return create(dir, slug)
}

// create opens (appending to) a transcript file. Named sessions are
// guarded against reuse by NewSessionNamed's existence check.
func create(dir, name string) (*Session, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, name+".jsonl")
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, err
	}
	return &Session{Path: path}, f.Close()
}

// slugify reduces a session name to a filename-safe slug.
func slugify(name string) string {
	var b strings.Builder
	dashed := true // suppress a leading dash
	for _, r := range strings.ToLower(strings.TrimSpace(name)) {
		switch {
		case r >= 'a' && r <= 'z' || r >= '0' && r <= '9' || r == '_' || r == '-':
			b.WriteRune(r)
			dashed = false
		default:
			if !dashed {
				b.WriteByte('-')
				dashed = true
			}
		}
		if b.Len() >= maxNameLen {
			break
		}
	}
	return strings.Trim(b.String(), "-_")
}

// LoadSessions lists stored transcripts, newest first. Empty transcripts
// (abandoned sessions) are skipped; a missing directory is ErrNoSessions.
func LoadSessions(dir string) ([]Info, error) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, ErrNoSessions
		}
		return nil, fmt.Errorf("listing sessions: %w", err)
	}
	var infos []Info
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".jsonl" {
			continue
		}
		path := filepath.Join(dir, e.Name())
		n, err := countLines(path)
		if err != nil || n == 0 {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		infos = append(infos, Info{
			Name:     strings.TrimSuffix(e.Name(), ".jsonl"),
			Path:     path,
			ModTime:  fi.ModTime(),
			Messages: n,
		})
	}
	if len(infos) == 0 {
		return nil, ErrNoSessions
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].ModTime.After(infos[j].ModTime) })
	return infos, nil
}

// countLines counts non-empty transcript lines.
func countLines(path string) (int, error) {
	f, err := os.Open(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	n := 0
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		if strings.TrimSpace(sc.Text()) != "" {
			n++
		}
	}
	return n, sc.Err()
}

// Open loads an existing transcript by path.
func Open(path string) (*Session, error) {
	s := &Session{Path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

// LoadLatest resumes the most recently modified session.
func LoadLatest(dir string) (*Session, error) {
	infos, err := LoadSessions(dir)
	if err != nil {
		return nil, err
	}
	return Open(infos[0].Path)
}

// LoadByName resumes a session by name: exact match first (case
// insensitive), then unique prefix. Ambiguous prefixes name the
// candidates so the caller can disambiguate.
func LoadByName(dir, name string) (*Session, error) {
	infos, err := LoadSessions(dir)
	if err != nil {
		return nil, err
	}
	lower := strings.ToLower(name)
	var partial []Info
	for _, in := range infos {
		ln := strings.ToLower(in.Name)
		if ln == lower {
			return Open(in.Path)
		}
		if strings.HasPrefix(ln, lower) {
			partial = append(partial, in)
		}
	}
	switch len(partial) {
	case 0:
		return nil, fmt.Errorf("no session named %q", name)
	case 1:
		return Open(partial[0].Path)
	default:
		names := make([]string, 0, len(partial))
		for _, in := range partial {
			names = append(names, in.Name)
		}
		return nil, fmt.Errorf("%q is ambiguous: %s", name, strings.Join(names, ", "))
	}
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
		s.msgs = append(s.msgs, llm.Message{
			Role:       l.Role,
			Content:    l.Content,
			ToolCalls:  l.ToolCalls,
			ToolResult: l.ToolResult,
		})
	}
	return sc.Err()
}

// Append records a turn and persists it immediately (crash-safe-ish).
// Memory sessions keep the message only.
func (s *Session) Append(m llm.Message) error {
	s.msgs = append(s.msgs, m)
	if s.Path == "" {
		return nil
	}

	data, err := marshalLine(m)
	if err != nil {
		return err
	}
	f, err := os.OpenFile(s.Path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Write(append(data, '\n')); err != nil {
		return err
	}
	return f.Sync()
}

// Replace atomically rewrites the whole transcript with msgs (used by
// compaction): lines go to a temp file that is synced and renamed into
// place, so a crash leaves either the old or the new transcript intact.
// Memory sessions swap the slice in place.
func (s *Session) Replace(msgs []llm.Message) error {
	if s.Path == "" {
		s.msgs = append([]llm.Message(nil), msgs...)
		return nil
	}
	var buf bytes.Buffer
	for _, m := range msgs {
		data, err := marshalLine(m)
		if err != nil {
			return err
		}
		buf.Write(data)
		buf.WriteByte('\n')
	}
	tmp := s.Path + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, s.Path); err != nil {
		os.Remove(tmp)
		return err
	}
	s.msgs = append([]llm.Message(nil), msgs...)
	return nil
}

// marshalLine encodes one transcript line (schema shared with load).
func marshalLine(m llm.Message) ([]byte, error) {
	return json.Marshal(line{
		TS:         time.Now().UTC().Format(time.RFC3339),
		Role:       m.Role,
		Content:    m.Content,
		ToolCalls:  m.ToolCalls,
		ToolResult: m.ToolResult,
	})
}

// Messages returns the full conversation history.
func (s *Session) Messages() []llm.Message { return s.msgs }

// Name returns the session's name (file name without the .jsonl suffix).
func (s *Session) Name() string {
	if s.Path == "" {
		return "memory"
	}
	return strings.TrimSuffix(filepath.Base(s.Path), ".jsonl")
}
