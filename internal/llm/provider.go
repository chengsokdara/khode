// Package llm defines the provider-agnostic contract khode uses to talk to
// LLM backends. Every provider (anthropic, openai, ...) translates its own
// wire format into the Message / Request / Event types defined here, so the
// agent loop and UI never depend on a specific SDK.
package llm

import (
	"context"
	"encoding/json"
)

// Role identifies who authored a message in the conversation.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
	// RoleTool carries the result of one tool call; providers translate it
	// into their own shape (Anthropic: user tool_result block, OpenAI:
	// role-"tool" message).
	RoleTool Role = "tool"
)

// ToolDef advertises a callable tool to the model.
type ToolDef struct {
	Name        string
	Description string
	// Parameters is the JSON-schema object describing the tool input.
	Parameters json.RawMessage
}

// ToolCall is one tool invocation requested by the model.
type ToolCall struct {
	ID    string          `json:"id"`
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// ToolResult answers the ToolCall whose ID is CallID.
type ToolResult struct {
	CallID  string `json:"call_id"`
	Content string `json:"content"`
	IsError bool   `json:"is_error"`
}

// Message is a single turn in the conversation, provider-agnostic. A user
// or assistant turn fills Content; an assistant turn that calls tools also
// fills ToolCalls; a tool turn fills ToolResult.
type Message struct {
	Role    Role   `json:"role"`
	Content string `json:"content"`
	// Thinking is the assistant's reasoning for this turn, kept for
	// display on resume only: providers never replay it to the API.
	Thinking string `json:"thinking,omitempty"`
	// ToolCalls lists the calls requested by an assistant turn.
	ToolCalls []ToolCall `json:"tool_calls,omitempty"`
	// ToolResult carries the outcome of one tool call (role tool).
	ToolResult *ToolResult `json:"tool_result,omitempty"`
}

// Request is a provider-agnostic completion request.
type Request struct {
	System    string
	Model     string
	MaxTokens int
	Messages  []Message
	Tools     []ToolDef
}

// Event is one item streamed back by a Provider. Implementations send zero
// or more TextDeltaEvent / ThinkingDeltaEvent / ToolCallEvent / UsageEvent
// values, at most one ErrorEvent, exactly one DoneEvent, then close the
// channel.
type Event interface {
	isEvent()
}

// TextDeltaEvent carries an incremental chunk of assistant text.
type TextDeltaEvent struct {
	Text string
}

// ThinkingDeltaEvent carries an incremental chunk of the model's reasoning
// (Anthropic thinking blocks, DeepSeek-style reasoning_content, or inline
// <think> tags on OpenAI-protocol streams) as opposed to its answer.
type ThinkingDeltaEvent struct {
	Text string
}

// ToolCallEvent reports a tool call the model finished requesting. The
// Input JSON is complete when the event is emitted.
type ToolCallEvent struct {
	ToolCall
}

// ToolResultEvent reports a finished tool execution.
type ToolResultEvent struct {
	CallID  string
	Name    string
	Output  string
	IsError bool
}

// UsageEvent reports token consumption for the completed response.
type UsageEvent struct {
	InputTokens  int64
	OutputTokens int64
}

// CompactEvent reports that the agent loop rewrote the session with an
// LLM summary: Removed messages became part of the summary, Kept recent
// messages stay verbatim.
type CompactEvent struct {
	Removed int
	Kept    int
}

// ErrorEvent reports a failure (including context.Canceled when the user
// interrupts a stream).
type ErrorEvent struct {
	Err error
}

// DoneEvent marks the successful end of a response.
type DoneEvent struct{}

func (TextDeltaEvent) isEvent()     {}
func (ThinkingDeltaEvent) isEvent() {}
func (ToolCallEvent) isEvent()      {}
func (ToolResultEvent) isEvent()    {}
func (UsageEvent) isEvent()         {}
func (CompactEvent) isEvent()       {}
func (ErrorEvent) isEvent()         {}
func (DoneEvent) isEvent()          {}

// Provider streams completions for a chat conversation.
type Provider interface {
	// Name returns a short identifier, e.g. "anthropic".
	Name() string
	// Stream starts a completion and returns a channel of events. The
	// channel must always be drained to avoid leaking the internal
	// goroutine; cancelling ctx stops it.
	Stream(ctx context.Context, req Request) (<-chan Event, error)
}
