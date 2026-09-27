package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"khode/internal/hooks"
	"khode/internal/llm"
	"khode/internal/perm"
	"khode/internal/tools"
)

// Subagents: the task tool spawns a Runner with a fresh in-memory
// session, so one focused subtask gets its own context window. The
// parent agent sees only the subagent's final report.

// maxTaskResult caps the default (general-purpose) subagent report so a
// verbose child cannot flood the parent's context window; other kinds
// cap lower via their kindSpec.ReportCap.
const maxTaskResult = 16 << 10

// SubagentProgress is one line of a running subagent's activity,
// forwarded to the UI while the child works. CallID is the parent's
// task call id, so parallel children feed separate lines.
type SubagentProgress struct {
	CallID   string // the parent's task tool call id
	Kind     string // the profile label ("general", "explore", "gather", "plan")
	Activity string // the child's latest tool call, e.g. "read internal/llm/loop.go"
	Calls    int    // child tool calls so far
}

// SubagentConfig wires the task tool to the app's live state. The
// function fields are read at every call, so /model and /mode changes
// apply to subagents spawned later.
type SubagentConfig struct {
	Provider  llm.Provider
	Workdir   string
	Model     func() string
	MaxTokens func() int
	Mode      func() perm.Mode
	// SubModel is an optional faster/cheaper model for subagents
	// (explore and gather sweeps fit small models); "" falls back to
	// Model. A kind's own model pin (user agents' `model` frontmatter
	// field) beats both.
	SubModel func() string
	// ToolSource is the main tool registry user-defined kinds borrow
	// non-built-in tools (MCP) from; nil restricts them to the built-in
	// constructors. The registry is only read.
	ToolSource func() *tools.Registry
	// Approver is shared with the main loop: a subagent's risky call
	// raises the same approval dialog in the UI.
	Approver Approver
	// Hooks builds the lifecycle-hook runner for subagent calls; nil
	// disables hooks inside subagents.
	Hooks func() *hooks.Runner
	// Progress receives one-line child activity while a subagent runs;
	// nil disables progress reporting. It must not block: the UI side
	// drops lines when its buffer is full.
	Progress func(SubagentProgress)
}

// TaskTool runs one subagent per call.
type TaskTool struct{ cfg SubagentConfig }

// NewTaskTool builds the task tool.
func NewTaskTool(cfg SubagentConfig) *TaskTool { return &TaskTool{cfg: cfg} }

func (t *TaskTool) Name() string { return "task" }

func (t *TaskTool) Description() string {
	return "Spawn a subagent with a fresh context window for one self-contained " +
		"subtask. " + kindSummary() + " The subagent has no memory of this " +
		"conversation, so the prompt must be complete and standalone. Only " +
		"its final message is returned; the rest of its work is discarded."
}

// kindSummary describes the kinds the schema enumerates: the built-in
// profiles plus any loaded user agents.
func kindSummary() string {
	parts := make([]string, 0, 4)
	for _, name := range KindNames() {
		spec, ok := lookupKind(SubagentKind(name))
		if !ok {
			continue
		}
		switch {
		case name == string(SubagentGeneral):
			parts = append(parts, "general-purpose (default) has your full toolset for "+
				"open-ended work, including any mutating work")
		default:
			d := spec.Description
			if d == "" {
				d = "a user-defined profile"
			}
			parts = append(parts, name+" — "+clipLine(d, 90))
		}
	}
	return "Kinds: " + strings.Join(parts, "; ") + "."
}

func (t *TaskTool) Schema() json.RawMessage {
	enum := make([]string, 0, 6)
	for _, name := range KindNames() {
		enum = append(enum, strconv.Quote(name))
	}
	return json.RawMessage(fmt.Sprintf(`{
  "type": "object",
  "properties": {
    "subagent_type": {"type": "string", "enum": [%s], "default": "general-purpose", "description": %s},
    "description": {"type": "string", "description": "Short 3-5 word label describing the subtask, shown while it runs"},
    "prompt": {"type": "string", "description": "Complete, standalone instructions: the goal, the relevant paths and facts, and what the final report should contain"}
  },
  "required": ["prompt"]
}`, strings.Join(enum, ", "), strconv.Quote(kindSummary())))
}

// Exec runs the subagent synchronously and returns its final message.
func (t *TaskTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Prompt       string `json:"prompt"`
		SubagentType string `json:"subagent_type"`
		Description  string `json:"description"` // display-only; the UI renders it
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(a.Prompt) == "" {
		return "", fmt.Errorf("prompt is required")
	}
	kind, spec := normalizeKind(a.SubagentType)

	model := t.cfg.Model()
	if t.cfg.SubModel != nil {
		if fast := t.cfg.SubModel(); fast != "" {
			model = fast
		}
	}
	if spec.Model != "" {
		model = spec.Model // a kind's own pin beats the global override
	}

	sub := &Runner{
		Provider:  t.cfg.Provider,
		Session:   NewMemorySession(),
		Tools:     registryFor(kind, t.cfg.Workdir, t.toolSource()),
		Model:     model,
		MaxTokens: t.cfg.MaxTokens(),
		System:    t.subagentSystem(spec),
		Mode:      t.cfg.Mode, // live: subagents follow mid-turn switches too
		Approver:  t.cfg.Approver,
	}
	if t.cfg.Hooks != nil {
		sub.Hooks = t.cfg.Hooks()
	}

	var report strings.Builder
	calls := 0
	for ev := range sub.Run(ctx, a.Prompt) {
		switch e := ev.(type) {
		case llm.TextDeltaEvent:
			report.WriteString(e.Text)
		case llm.ToolCallEvent:
			calls++
			if t.cfg.Progress != nil {
				t.cfg.Progress(SubagentProgress{
					CallID:   callIDFromContext(ctx),
					Kind:     spec.Label,
					Activity: progressLine(e.Name, e.Input),
					Calls:    calls,
				})
			}
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
	return clipTaskResult(out, spec.ReportCap), nil
}

// callIDFromContext returns the parent loop's running tool call id; a
// task Exec driven directly (tests, no loop) carries none.
func callIDFromContext(ctx context.Context) string {
	id, _ := ctx.Value(callIDContextKey{}).(string)
	return id
}

// Exclusive implements tools.ExclusiveTool: only all-read children may
// run side by side with their siblings (they cannot mutate and never
// raise an approval dialog), any child that could mutate runs alone.
// Unknown kinds normalize to general-purpose, which is exclusive.
func (t *TaskTool) Exclusive(args json.RawMessage) bool {
	var a struct {
		SubagentType string `json:"subagent_type"`
	}
	_ = json.Unmarshal(args, &a)
	_, spec := normalizeKind(a.SubagentType)
	return !kindIsReadOnly(spec)
}

// subagentSystem keeps the project context (AGENTS.md guidance applies
// to subagent work too), adds the reporting contract, and appends the
// kind's own section.
func (t *TaskTool) subagentSystem(spec kindSpec) string {
	return subagentSystemPrompt(t.cfg.Workdir, spec)
}

// toolSource resolves the registry user kinds borrow MCP tools from;
// nil config means built-in constructors only.
func (t *TaskTool) toolSource() *tools.Registry {
	if t.cfg.ToolSource == nil {
		return nil
	}
	return t.cfg.ToolSource()
}

// progressLine flattens a child tool call into one short activity line
// for the parent's feed: the tool's one interesting argument when it
// has a shape, the bare name otherwise.
func progressLine(name string, input json.RawMessage) string {
	var a struct {
		Command string `json:"command"`
		Path    string `json:"path"`
		Pattern string `json:"pattern"`
	}
	_ = json.Unmarshal(input, &a)
	arg := a.Command
	if arg == "" {
		arg = a.Pattern
	}
	if arg == "" {
		arg = a.Path
	}
	if arg == "" {
		return name
	}
	flat := strings.Join(strings.Fields(arg), " ")
	return name + " " + clipLine(flat, 80)
}

// clipLine hard-cuts a string to n runes.
func clipLine(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "…"
}

// clipTaskResult caps a report for its kind, reserving room for the
// marker so the output never exceeds the cap.
func clipTaskResult(s string, cap int) string {
	const marker = "\n\n(…truncated)"
	if len(s) <= cap {
		return s
	}
	return s[:cap-len(marker)] + marker
}

// interface guard: the task tool satisfies the tool contract.
var _ tools.Tool = (*TaskTool)(nil)
