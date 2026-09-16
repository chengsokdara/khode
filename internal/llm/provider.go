// Package llm defines the provider-agnostic contract khode uses to talk to
// LLM backends. Every provider (anthropic, openai, ...) translates its own
// wire format into the Message / Request / Event types defined here, so the
// agent loop and UI never depend on a specific SDK.
package llm

import "context"

// Role identifies who authored a message in the conversation.
type Role string

const (
	RoleUser      Role = "user"
	RoleAssistant Role = "assistant"
)

// Message is a single turn in the conversation, provider-agnostic.
type Message struct {
	Role    Role   `json:"role"`
	Content string `json:"content"`
}

// Request is a provider-agnostic completion request.
type Request struct {
	System    string
	Model     string
	MaxTokens int
	Messages  []Message
}

// Event is one item streamed back by a Provider. Implementations send zero
// or more TextDeltaEvent / UsageEvent values, at most one ErrorEvent, exactly
// one DoneEvent, then close the channel.
type Event interface {
	isEvent()
}

// TextDeltaEvent carries an incremental chunk of assistant text.
type TextDeltaEvent struct {
	Text string
}

// UsageEvent reports token consumption for the completed response.
type UsageEvent struct {
	InputTokens  int64
	OutputTokens int64
}

// ErrorEvent reports a failure (including context.Canceled when the user
// interrupts a stream).
type ErrorEvent struct {
	Err error
}

// DoneEvent marks the successful end of a response.
type DoneEvent struct{}

func (TextDeltaEvent) isEvent() {}
func (UsageEvent) isEvent()     {}
func (ErrorEvent) isEvent()     {}
func (DoneEvent) isEvent()      {}

// Provider streams completions for a chat conversation.
type Provider interface {
	// Name returns a short identifier, e.g. "anthropic".
	Name() string
	// Stream starts a completion and returns a channel of events. The
	// channel must always be drained to avoid leaking the internal
	// goroutine; cancelling ctx stops it.
	Stream(ctx context.Context, req Request) (<-chan Event, error)
}
