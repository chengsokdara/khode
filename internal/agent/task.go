package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"khode/internal/hooks"
	"khode/internal/llm"
	"khode/internal/perm"
	"khode/internal/tools"
)

// Subagents: the task tool spawns a Runner with a fresh in-memory
// session, so one focused subtask gets its own context window. The
// parent agent sees only the subagent's final report.

// maxTaskResult caps a subagent report so a verbose child cannot flood
// the parent's context window.
const maxTaskResult = 16 << 10

// SubagentConfig wires the task tool to the app's live state. The
// function fields are read at every call, so /model and /mode changes
// apply to subagents spawned later.
type SubagentConfig struct {
	Provider  llm.Provider
	Workdir   string
	Model     func() string
	MaxTokens func() int
	Mode      func() perm.Mode
	// Approver is shared with the main loop: a subagent's risky call
	// raises the same approval dialog in the UI.
	Approver Approver
	// Hooks builds the lifecycle-hook runner for subagent calls; nil
	// disables hooks inside subagents.
	Hooks func() *hooks.Runner
}

// TaskTool runs one subagent per call.
type TaskTool struct{ cfg SubagentConfig }

// NewTaskTool builds the task tool.
func NewTaskTool(cfg SubagentConfig) *TaskTool { return &TaskTool{cfg: cfg} }

func (t *TaskTool) Name() string { return "task" }

func (t *TaskTool) Description() string {
	return "Spawn a subagent with a fresh context window for one self-contained " +
		"subtask — a broad search, a deep dive, or a long investigation whose " +
		"intermediate output you do not need. The subagent has the same tools " +
		"and permissions as you but no memory of this conversation, so its " +
		"prompt must be complete and standalone. Its final message is returned " +
		"as the result; the rest of its work is discarded."
}

func (t *TaskTool) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "prompt": {"type": "string", "description": "Complete, standalone instructions: the goal, the relevant paths and facts, and what the final report should contain"}
  },
  "required": ["prompt"]
}`)
}

// Exec runs the subagent synchronously and returns its final message.
func (t *TaskTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Prompt string `json:"prompt"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(a.Prompt) == "" {
		return "", fmt.Errorf("prompt is required")
	}

	sub := &Runner{
		Provider:  t.cfg.Provider,
		Session:   NewMemorySession(),
		Tools:     tools.Default(t.cfg.Workdir), // no task: subagents do not recurse
		Model:     t.cfg.Model(),
		MaxTokens: t.cfg.MaxTokens(),
		System:    t.subagentSystem(),
		Mode:      t.cfg.Mode, // live: subagents follow mid-turn switches too
		Approver:  t.cfg.Approver,
	}
	if t.cfg.Hooks != nil {
		sub.Hooks = t.cfg.Hooks()
	}

	var report strings.Builder
	for ev := range sub.Run(ctx, a.Prompt) {
		switch e := ev.(type) {
		case llm.TextDeltaEvent:
			report.WriteString(e.Text)
		case llm.ErrorEvent:
			if errors.Is(e.Err, context.Canceled) {
				return "", e.Err // the loop's "interrupted by user" wording wins
			}
			return "", fmt.Errorf("subagent failed: %w", e.Err)
		}
	}
	out := strings.TrimSpace(report.String())
	if out == "" {
		return "(the subagent finished without a report)", nil
	}
	return clipTaskResult(out), nil
}

// subagentSystem keeps the project context (AGENTS.md guidance applies
// to subagent work too) and adds the reporting contract.
func (t *TaskTool) subagentSystem() string {
	return SystemPrompt(t.cfg.Workdir) + `

# Subagent

You are running as a subagent spawned by the main agent for one task. You
have your own tools and a fresh context; nobody sees your intermediate
work. Work only on the given task, then end with a final message that is
a complete, self-contained report of what you found or changed — it is
the only part of your run the parent agent receives.`
}

// clipTaskResult caps a report, reserving room for the marker so the
// output never exceeds the cap.
func clipTaskResult(s string) string {
	const marker = "\n\n(…truncated)"
	if len(s) <= maxTaskResult {
		return s
	}
	return s[:maxTaskResult-len(marker)] + marker
}

// interface guard: the task tool satisfies the tool contract.
var _ tools.Tool = (*TaskTool)(nil)
