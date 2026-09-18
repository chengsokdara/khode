package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"khode/internal/debug"
	"khode/internal/hooks"
	"khode/internal/llm"
	"khode/internal/perm"
	"khode/internal/tools"
)

// DefaultMaxRounds caps the stream→tool→stream cycles of one user turn so
// a model stuck calling tools cannot loop forever.
const DefaultMaxRounds = 25

// Runner executes one user turn as an agentic loop: stream a model
// response, execute any requested tools, feed the results back, and
// repeat until the model answers without tool calls (or the round cap is
// hit). Every session write happens here, keeping agent.Session the
// single source of truth while the UI stays display-only.
type Runner struct {
	Provider  llm.Provider
	Session   *Session
	Tools     *tools.Registry
	Model     string
	MaxTokens int
	System    string
	// MaxRounds bounds the tool loop; 0 means DefaultMaxRounds.
	MaxRounds int
	// Mode selects the permission policy; empty means perm.DefaultMode.
	Mode perm.Mode
	// Approver resolves perm.DecisionAsk outcomes; nil declines them.
	Approver Approver
	// Hooks runs the user's lifecycle hooks around tool calls; nil
	// disables them.
	Hooks *hooks.Runner

	// lastInput is the most recent provider-reported input-token count,
	// the exact signal behind the compaction trigger; 0 until the turn's
	// first UsageEvent (estimates fill in before that).
	lastInput int
}

// Run appends the user turn and drives the loop, forwarding stream events
// on the returned channel. The channel carries zero or more
// TextDeltaEvent / ToolCallEvent / ToolResultEvent / UsageEvent /
// CompactEvent values, then exactly one ErrorEvent or DoneEvent before
// closing — the same termination contract as Provider.Stream.
func (r *Runner) Run(ctx context.Context, userText string) <-chan llm.Event {
	out := make(chan llm.Event, 64)
	go func() {
		defer close(out)

		if err := r.Session.Append(llm.Message{Role: llm.RoleUser, Content: userText}); err != nil {
			out <- llm.ErrorEvent{Err: fmt.Errorf("appending user message: %w", err)}
			return
		}
		debug.Printf("turn start: model=%s session=%s", r.Model, r.Session.Name())

		maxRounds := r.MaxRounds
		if maxRounds <= 0 {
			maxRounds = DefaultMaxRounds
		}
		for round := 0; round < maxRounds; round++ {
			r.maybeCompact(ctx, out)
			calls, err := r.round(ctx, out)
			if err != nil {
				out <- llm.ErrorEvent{Err: err}
				return
			}
			if len(calls) == 0 {
				out <- llm.DoneEvent{}
				return
			}
			if err := r.executeCalls(ctx, calls, out); err != nil {
				out <- llm.ErrorEvent{Err: err}
				return
			}
			if err := ctx.Err(); err != nil {
				out <- llm.ErrorEvent{Err: err}
				return
			}
		}
		out <- llm.ErrorEvent{Err: fmt.Errorf("tool loop stopped after %d rounds", maxRounds)}
	}()
	return out
}

// round streams one model response into out, appending the assistant turn
// to the session when it completes. Provider-level DoneEvents are absorbed
// — they mark round boundaries, and Run owns the turn-level DoneEvent.
// It returns the tool calls the model requested, if any.
func (r *Runner) round(ctx context.Context, out chan<- llm.Event) ([]llm.ToolCall, error) {
	ch, err := r.Provider.Stream(ctx, llm.Request{
		System:    r.System,
		Model:     r.Model,
		MaxTokens: r.MaxTokens,
		Messages:  r.Session.Messages(),
		Tools:     r.Tools.Definitions(),
	})
	if err != nil {
		return nil, fmt.Errorf("starting stream: %w", err)
	}

	var text, think strings.Builder
	var calls []llm.ToolCall
	sawTerminal := false
	for ev := range ch {
		switch e := ev.(type) {
		case llm.TextDeltaEvent:
			text.WriteString(e.Text)
			out <- ev
		case llm.ThinkingDeltaEvent:
			think.WriteString(e.Text)
			out <- ev
		case llm.ToolCallEvent:
			calls = append(calls, e.ToolCall)
			out <- ev
		case llm.UsageEvent:
			r.lastInput = int(e.InputTokens)
			out <- ev
		case llm.ErrorEvent:
			return nil, e.Err
		case llm.DoneEvent:
			sawTerminal = true
		}
	}
	if !sawTerminal {
		return nil, errors.New("provider stream closed without a terminal event")
	}

	// Malformed model output must never poison the transcript: a
	// non-JSON tool input would make Session.Append fail and kill the
	// turn. Execution still sees the original bytes so the tool's
	// argument error tells the model precisely what went wrong.
	msgCalls := make([]llm.ToolCall, len(calls))
	for i := range calls {
		msgCalls[i] = calls[i]
		msgCalls[i].Input = sanitizeToolInput(calls[i].Input)
	}

	// An empty reply with no calls (rare) is not worth a transcript line.
	if text.Len() > 0 || think.Len() > 0 || len(calls) > 0 {
		msg := llm.Message{Role: llm.RoleAssistant, Content: text.String(), Thinking: think.String(), ToolCalls: msgCalls}
		if err := r.Session.Append(msg); err != nil {
			return nil, fmt.Errorf("appending assistant turn: %w", err)
		}
	}
	debug.Printf("round done: %d answer chars, %d thinking chars, %d tool calls", text.Len(), think.Len(), len(calls))
	return calls, nil
}

// sanitizeToolInput coerces a tool call's input into valid JSON for the
// transcript; models occasionally emit fragments that are not valid JSON.
func sanitizeToolInput(raw json.RawMessage) json.RawMessage {
	if len(raw) == 0 {
		return json.RawMessage("{}")
	}
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		return json.RawMessage("{}")
	}
	return raw
}

// executeCalls runs each requested tool in order, appending one result
// message per call — even on cancellation, so the transcript never ends
// with an unanswered tool call (providers reject that pairing).
func (r *Runner) executeCalls(ctx context.Context, calls []llm.ToolCall, out chan<- llm.Event) error {
	for _, c := range calls {
		output, execErr := r.execCall(ctx, c)
		res := llm.ToolResult{CallID: c.ID, IsError: execErr != nil}
		switch {
		case execErr == nil:
			res.Content = output
		case errors.Is(execErr, context.Canceled):
			res.Content = "interrupted by user"
		default:
			res.Content = execErr.Error()
		}
		if err := r.Session.Append(llm.Message{Role: llm.RoleTool, ToolResult: &res}); err != nil {
			return fmt.Errorf("appending tool result: %w", err)
		}
		out <- llm.ToolResultEvent{CallID: c.ID, Name: c.Name, Output: res.Content, IsError: res.IsError}
	}
	return nil
}

func (r *Runner) execCall(ctx context.Context, c llm.ToolCall) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	tool, ok := r.Tools.Get(c.Name)
	if !ok {
		return "", fmt.Errorf("unknown tool %q", c.Name)
	}
	if !r.Tools.Enabled(c.Name) {
		return "", fmt.Errorf("tool %q is disabled — the user turned it off in /tools", c.Name)
	}

	mode := r.Mode
	if mode == "" {
		mode = perm.DefaultMode
	}
	risk := r.Tools.RiskOf(c.Name)
	decision := perm.Decide(mode, risk)
	debug.Printf("tool %s: risk=%s mode=%s decision=%v", c.Name, risk, mode, decision)
	switch decision {
	case perm.DecisionDeny:
		return "", fmt.Errorf("%s tools are blocked in %s mode — present a plan with the plan tool instead; the user can switch modes with /mode",
			risk, mode)
	case perm.DecisionAsk:
		if r.Approver == nil || !r.Approver.Approve(ctx, c, risk, previewOf(tool, c.Input)) {
			return "", errors.New("the user declined this tool call")
		}
	}

	// Hooks run after permission decisions: only calls that are actually
	// about to execute. A pre_tool veto (exit 2) becomes the error.
	if r.Hooks != nil {
		if err := r.Hooks.PreTool(ctx, c.Name, c.Input); err != nil {
			return "", err
		}
	}
	out, err := tool.Exec(ctx, c.Input)
	if r.Hooks != nil {
		r.Hooks.PostTool(ctx, c.Name, c.Input, out, err)
	}
	return out, err
}

// previewOf asks a tool what it would change, for the approval dialog;
// tools without a preview render nothing extra.
func previewOf(tool tools.Tool, args json.RawMessage) string {
	p, ok := tool.(tools.Previewer)
	if !ok {
		return ""
	}
	s, err := p.Preview(args)
	if err != nil {
		return fmt.Sprintf("(preview unavailable: %v)", err)
	}
	return s
}

// DefaultSystemPrompt describes khode and anchors tool use in workdir.
func DefaultSystemPrompt(workdir string) string {
	return fmt.Sprintf(`You are khode, a coding assistant working in %s.
You can inspect the project (read, glob, grep) and change it (edit, write,
bash). Prefer the inspection tools over guessing about file contents, and
make several independent calls in one turn when you can. Use edit for
surgical string replacements; use write only for new files or full
rewrites. Tool calls may need the user's approval — if one is declined,
adapt instead of retrying it unchanged. In plan mode nothing can be
modified: investigate, then present your complete plan with the plan
tool; implementation starts once the user approves it. Be concise and
practical. Prefer exact commands and code over prose. Format responses
in markdown.`, workdir)
}
