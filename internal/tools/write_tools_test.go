package tools

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestEditUniqueReplace(t *testing.T) {
	root := writeTree(t)
	e := &Edit{Root: root}

	out := mustExec(t, e, `{"path":"internal/llm/llm.go","old_string":"// TODO stream\nvar X = 1","new_string":"var X = 1"}`)
	if !strings.Contains(out, "internal/llm/llm.go") || !strings.Contains(out, "1 occurrence") {
		t.Errorf("edit summary = %q", out)
	}
	data, err := os.ReadFile(filepath.Join(root, "internal/llm/llm.go"))
	if err != nil {
		t.Fatal(err)
	}
	if want := "package llm\n\nvar X = 1\n"; string(data) != want {
		t.Errorf("file after edit = %q, want %q", data, want)
	}
}

func TestEditMatchRules(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("x\nx\nkeep\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	e := &Edit{Root: root}

	if _, err := e.Exec(t.Context(), json.RawMessage(`{"path":"f.txt","old_string":"nope","new_string":"y"}`)); err == nil || !strings.Contains(err.Error(), "not found") {
		t.Errorf("missing match error = %v", err)
	}
	if _, err := e.Exec(t.Context(), json.RawMessage(`{"path":"f.txt","old_string":"x","new_string":"y"}`)); err == nil || !strings.Contains(err.Error(), "2 locations") {
		t.Errorf("ambiguous match error = %v", err)
	}
	if _, err := e.Exec(t.Context(), json.RawMessage(`{"path":"f.txt","old_string":"x","new_string":"x"}`)); err == nil || !strings.Contains(err.Error(), "identical") {
		t.Errorf("no-op edit error = %v", err)
	}
	if _, err := e.Exec(t.Context(), json.RawMessage(`{"path":"f.txt","old_string":"","new_string":"y"}`)); err == nil || !strings.Contains(err.Error(), "old_string is required") {
		t.Errorf("empty old_string error = %v", err)
	}
	if _, err := e.Exec(t.Context(), json.RawMessage(`{"path":"missing.txt","old_string":"x","new_string":"y"}`)); err == nil {
		t.Error("missing file: want error")
	}

	// replace_all rewrites every occurrence.
	out := mustExec(t, e, `{"path":"f.txt","old_string":"x","new_string":"y","replace_all":true}`)
	if !strings.Contains(out, "2 occurrences") {
		t.Errorf("replace_all summary = %q", out)
	}
	data, _ := os.ReadFile(filepath.Join(root, "f.txt"))
	if string(data) != "y\ny\nkeep\n" {
		t.Errorf("file after replace_all = %q", data)
	}
}

func TestEditPreviewDoesNotWrite(t *testing.T) {
	root := writeTree(t)
	e := &Edit{Root: root}
	before, err := os.ReadFile(filepath.Join(root, "main.go"))
	if err != nil {
		t.Fatal(err)
	}

	preview, err := e.Preview(json.RawMessage(`{"path":"main.go","old_string":"func main() {}","new_string":"func main() {\n\tpanic(\"x\")\n}"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview, "-func main() {}") || !strings.Contains(preview, "+\tpanic(") {
		t.Errorf("preview diff = %q", preview)
	}
	after, _ := os.ReadFile(filepath.Join(root, "main.go"))
	if string(before) != string(after) {
		t.Error("Preview modified the file")
	}
}

func TestWriteCreatesAndOverwrites(t *testing.T) {
	root := t.TempDir()
	w := &Write{Root: root}

	out := mustExec(t, w, `{"path":"a/b/new.txt","content":"hello\n"}`)
	if !strings.Contains(out, "a/b/new.txt") || !strings.Contains(out, "1 line") {
		t.Errorf("write summary = %q", out)
	}
	data, err := os.ReadFile(filepath.Join(root, "a/b/new.txt"))
	if err != nil || string(data) != "hello\n" {
		t.Fatalf("new file = %q, %v", data, err)
	}

	// Overwriting preserves the file mode.
	if err := os.Chmod(filepath.Join(root, "a/b/new.txt"), 0o600); err != nil {
		t.Fatal(err)
	}
	out = mustExec(t, w, `{"path":"a/b/new.txt","content":"replaced\nlines\n"}`)
	if !strings.Contains(out, "2 lines") {
		t.Errorf("overwrite summary = %q", out)
	}
	fi, err := os.Stat(filepath.Join(root, "a/b/new.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0o600 {
		t.Errorf("mode after overwrite = %v, want 0600", fi.Mode().Perm())
	}

	out = mustExec(t, w, `{"path":"empty.txt","content":""}`)
	if !strings.Contains(out, "empty file") {
		t.Errorf("empty write summary = %q", out)
	}
	if _, err := w.Exec(t.Context(), json.RawMessage(`{"content":"x"}`)); err == nil {
		t.Error("missing path: want error")
	}
}

func TestWritePreview(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "f.txt"), []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	w := &Write{Root: root}

	preview, err := w.Preview(json.RawMessage(`{"path":"f.txt","content":"new\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview, "-old") || !strings.Contains(preview, "+new") {
		t.Errorf("overwrite preview = %q", preview)
	}

	preview, err = w.Preview(json.RawMessage(`{"path":"fresh.txt","content":"x\n"}`))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(preview, "+x") || strings.Contains(preview, "\n-") {
		t.Errorf("new-file preview = %q", preview)
	}
	if _, err := os.Stat(filepath.Join(root, "fresh.txt")); !errors.Is(err, os.ErrNotExist) {
		t.Error("Preview created the file")
	}
}

func TestBashRunsAndCaptures(t *testing.T) {
	b := &Bash{Root: t.TempDir()}

	out := mustExec(t, b, `{"command":"echo hello; echo err >&2"}`)
	if out != "hello\nerr" {
		t.Errorf("combined output = %q", out)
	}
}

func TestBashExitCodeCarriesOutput(t *testing.T) {
	b := &Bash{Root: t.TempDir()}
	_, err := b.Exec(t.Context(), json.RawMessage(`{"command":"echo out; exit 3"}`))
	if err == nil {
		t.Fatal("non-zero exit: want error")
	}
	if !strings.Contains(err.Error(), "out") || !strings.Contains(err.Error(), "exit code: 3") {
		t.Errorf("exit-code error = %v", err)
	}
}

func TestBashTimeout(t *testing.T) {
	b := &Bash{Root: t.TempDir()}
	start := time.Now()
	_, err := b.Exec(t.Context(), json.RawMessage(`{"command":"echo partial; sleep 30","timeout":1}`))
	if err == nil || !strings.Contains(err.Error(), "timed out after 1s") {
		t.Fatalf("timeout error = %v", err)
	}
	if !strings.Contains(err.Error(), "partial") {
		t.Errorf("timeout error lost partial output: %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Errorf("timeout took %s; the command was not killed", time.Since(start))
	}
}

// A backgrounded child keeps the output pipe open after the shell dies;
// the process-group kill must reap it or cmd.Wait hangs.
func TestBashTimeoutKillsChildren(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix process groups")
	}
	b := &Bash{Root: t.TempDir()}
	start := time.Now()
	_, err := b.Exec(t.Context(), json.RawMessage(`{"command":"sleep 30 & echo bg; wait","timeout":1}`))
	if err == nil || !strings.Contains(err.Error(), "timed out") {
		t.Fatalf("timeout error = %v", err)
	}
	if time.Since(start) > 10*time.Second {
		t.Errorf("wait returned after %s; the child survived the kill", time.Since(start))
	}
}

func TestBashCwdIsRoot(t *testing.T) {
	root := t.TempDir()
	b := &Bash{Root: root}
	out := mustExec(t, b, `{"command":"pwd"}`)
	got := strings.TrimSpace(out)
	want, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if got, err = filepath.EvalSymlinks(got); err != nil || got != want {
		t.Errorf("pwd = %q, want %q (%v)", got, want, err)
	}
}

func TestBashOutputCap(t *testing.T) {
	b := &Bash{Root: t.TempDir()}
	out := mustExec(t, b, `{"command":"seq 1 3000"}`)
	lines := strings.Split(out, "\n")
	if len(lines) != bashMaxOutputLines+1 || !strings.Contains(out, "more lines") {
		t.Errorf("capped output has %d lines, want %d + note: %q",
			len(lines), bashMaxOutputLines, lines[len(lines)-1])
	}
}

func TestBashArgValidation(t *testing.T) {
	b := &Bash{Root: t.TempDir()}
	if _, err := b.Exec(t.Context(), json.RawMessage(`{"command":""}`)); err == nil || !strings.Contains(err.Error(), "command is required") {
		t.Errorf("empty command error = %v", err)
	}
	preview, err := b.Preview(json.RawMessage(`{"command":"go test ./..."}`))
	if err != nil || preview != "go test ./..." {
		t.Errorf("bash preview = %q, %v", preview, err)
	}
}
