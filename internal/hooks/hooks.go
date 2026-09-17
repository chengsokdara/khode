// Package hooks runs the user's agent lifecycle hooks: shell commands
// fired around tool calls. Every hook gets one JSON payload on stdin
// describing the event. A pre_tool hook may block the tool call by
// exiting with code 2 — its stderr becomes the error the model sees;
// every other outcome is informational.
package hooks

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

	"khode/internal/config"
)

// defaultTimeout bounds one hook run; a hung hook must not freeze the
// turn, and a timeout never blocks the call.
const defaultTimeout = time.Minute

// BlockError is a pre_tool hook's veto. Its message is what the model
// receives as the failed tool call's error.
type BlockError struct{ Reason string }

func (e *BlockError) Error() string { return e.Reason }

// Runner executes hooks for one app instance.
type Runner struct {
	cfg config.Hooks
	dir string // working directory for hook commands: the project root

	// Timeout bounds one hook; overridable for tests.
	Timeout time.Duration
}

// New builds a Runner around the configured hooks.
func New(cfg config.Hooks, dir string) *Runner {
	return &Runner{cfg: cfg, dir: dir, Timeout: defaultTimeout}
}

// Enabled reports whether any hook is configured.
func (r *Runner) Enabled() bool {
	return len(r.cfg.PreTool) > 0 || len(r.cfg.PostTool) > 0
}

// PreTool runs every pre_tool hook matching the tool call. A hook that
// exits 2 blocks the call; the returned error carries its reason.
func (r *Runner) PreTool(ctx context.Context, tool string, args json.RawMessage) error {
	return r.run(ctx, "pre_tool", r.cfg.PreTool, tool, args, "", nil)
}

// PostTool runs every post_tool hook matching the call that just
// finished. Outcomes never affect the turn.
func (r *Runner) PostTool(ctx context.Context, tool string, args json.RawMessage, output string, execErr error) {
	_ = r.run(ctx, "post_tool", r.cfg.PostTool, tool, args, output, execErr)
}

// run executes each matching hook sequentially.
func (r *Runner) run(ctx context.Context, event string, list []config.Hook, tool string, args json.RawMessage, output string, execErr error) error {
	if len(list) == 0 {
		return nil
	}
	timeout := r.Timeout
	if timeout <= 0 {
		timeout = defaultTimeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	payload := hookPayload{Event: event, Tool: tool, Args: args, Output: output}
	if execErr != nil {
		payload.Error = execErr.Error()
	}
	data, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("encoding hook payload: %w", err)
	}

	for _, h := range list {
		if !matches(h, tool) {
			continue
		}
		if err := r.runOne(ctx, event, h, data); err != nil {
			return err
		}
	}
	return nil
}

// runOne runs one hook command. For pre_tool, exit code 2 blocks the
// call (returned as a BlockError); timeouts and other failures are
// non-blocking (nil error).
func (r *Runner) runOne(ctx context.Context, event string, h config.Hook, payload []byte) error {
	cmd := exec.CommandContext(ctx, "bash", "-c", h.Command)
	cmd.Dir = r.dir
	cmd.Env = append(os.Environ(), "KHODE_EVENT="+event)
	setHookProcessGroup(cmd)
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	cmd.Stdin = bytes.NewReader(payload)

	runErr := cmd.Run()
	if ctx.Err() != nil {
		return nil // hook timeout: never blocks, never fails the turn
	}
	var ee *exec.ExitError
	if errors.As(runErr, &ee) && ee.ExitCode() == 2 && event == "pre_tool" {
		reason := strings.TrimSpace(stderr.String())
		if reason == "" {
			reason = fmt.Sprintf("blocked by pre_tool hook: %s", h.Command)
		}
		return &BlockError{Reason: reason}
	}
	return nil
}

// matches reports whether a hook applies to this tool; a hook with no
// tool list applies to every call.
func matches(h config.Hook, tool string) bool {
	if len(h.Tools) == 0 {
		return true
	}
	for _, n := range h.Tools {
		if n == tool {
			return true
		}
	}
	return false
}

// hookPayload is the JSON a hook receives on stdin.
type hookPayload struct {
	Event  string          `json:"event"`
	Tool   string          `json:"tool"`
	Args   json.RawMessage `json:"args"`
	Output string          `json:"output,omitempty"`
	Error  string          `json:"error,omitempty"`
}
