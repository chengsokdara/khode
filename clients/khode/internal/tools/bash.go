package tools

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"khode/internal/perm"
)

// Bash caps for one call: a runaway command must neither hang the turn
// nor flood the model's context window.
const (
	bashDefaultTimeout = 30 * time.Second
	bashMaxTimeout     = 10 * time.Minute
	bashMaxOutputLines = 1000
	bashMaxOutputBytes = 32 << 10
)

// Bash runs a shell command in the project root.
type Bash struct{ Root string }

func (b *Bash) Risk() perm.Risk { return perm.RiskExec }

type bashArgs struct {
	Command string `json:"command"`
	Timeout int    `json:"timeout"` // seconds; 0 means the default
}

func (b *Bash) Name() string { return "bash" }

func (b *Bash) Description() string {
	return "Run a shell command in the project root and return its combined " +
		"stdout and stderr. Use for builds, tests, git, and other exact commands. " +
		"The command is killed after the timeout (default 30s, max 600)."
}

func (b *Bash) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "command": {"type": "string", "description": "The shell command to run"},
    "timeout": {"type": "integer", "description": "Seconds before the command is killed (default 30, max 600)"}
  },
  "required": ["command"]
}`)
}

// Preview returns the command itself; the approval dialog shows it as
// the thing being approved.
func (b *Bash) Preview(args json.RawMessage) (string, error) {
	var a bashArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Command == "" {
		return "", fmt.Errorf("command is required")
	}
	return a.Command, nil
}

// Exec runs the command with bash -c, captures combined output, and
// reports non-zero exits as error results that still carry the output.
func (b *Bash) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a bashArgs
	if err := arg(args, &a); err != nil {
		return "", err
	}
	if a.Command == "" {
		return "", fmt.Errorf("command is required")
	}
	timeout := time.Duration(a.Timeout) * time.Second
	if timeout <= 0 {
		timeout = bashDefaultTimeout
	}
	timeout = min(timeout, bashMaxTimeout)

	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	cmd := exec.CommandContext(ctx, "bash", "-c", a.Command)
	cmd.Dir = b.Root
	cmd.Env = os.Environ()
	setBashProcessGroup(cmd)

	var buf bytes.Buffer
	cmd.Stdout, cmd.Stderr = &buf, &buf
	if err := cmd.Start(); err != nil {
		return "", fmt.Errorf("starting command: %w", err)
	}
	waitErr := cmd.Wait()
	out := capBashOutput(buf.String())

	switch {
	case errors.Is(ctx.Err(), context.Canceled):
		// The user interrupted the turn; the loop wording wins.
		return "", context.Canceled
	case ctx.Err() != nil: // deadline exceeded
		return "", fmt.Errorf("timed out after %s%s", timeout, partialOutput(out))
	case waitErr == nil:
		return out, nil
	default:
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) && ee.ExitCode() >= 0 {
			return "", fmt.Errorf("%s\nexit code: %d", out, ee.ExitCode())
		}
		return "", fmt.Errorf("%s%s (%v)", out, partialOutput(out), waitErr)
	}
}

// partialOutput formats captured output for embedding in an error so a
// failed or killed command still shows what it printed.
func partialOutput(out string) string {
	if out == "" {
		return ""
	}
	return "\noutput:\n" + out
}

// capBashOutput trims captured output to the line and byte caps, noting
// the cut so the model knows more existed.
func capBashOutput(s string) string {
	s = strings.TrimRight(s, "\n")
	lines := strings.Split(s, "\n")
	if len(lines) > bashMaxOutputLines {
		s = strings.Join(lines[:bashMaxOutputLines], "\n") +
			fmt.Sprintf("\n... (%d more lines)", len(lines)-bashMaxOutputLines)
	}
	if len(s) > bashMaxOutputBytes {
		s = s[:bashMaxOutputBytes] + "\n... (output exceeded 32 KiB)"
	}
	return s
}

// interface guard: registry entries must satisfy the tool contract.
var (
	_ Tool           = (*Bash)(nil)
	_ Previewer      = (*Bash)(nil)
	_ RiskClassifier = (*Bash)(nil)
)
