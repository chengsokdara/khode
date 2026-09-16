package llm

import (
	"context"

	"github.com/anthropics/anthropic-sdk-go"
)

// Anthropic implements Provider against the official Anthropic SDK.
// It reads ANTHROPIC_API_KEY from the environment.
type Anthropic struct {
	client *anthropic.Client
}

// NewAnthropic builds an Anthropic provider with default environment auth.
func NewAnthropic() *Anthropic {
	client := anthropic.NewClient()
	return &Anthropic{client: &client}
}

func (a *Anthropic) Name() string { return "anthropic" }

// Stream translates the generic Request into an Anthropic messages stream
// and forwards deltas over a channel of generic Events.
func (a *Anthropic) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	if req.MaxTokens <= 0 {
		req.MaxTokens = 8192
	}
	maxTokens := int64(req.MaxTokens)

	msgs := make([]anthropic.MessageParam, 0, len(req.Messages))
	for _, m := range req.Messages {
		switch m.Role {
		case RoleUser:
			msgs = append(msgs, anthropic.NewUserMessage(anthropic.NewTextBlock(m.Content)))
		case RoleAssistant:
			msgs = append(msgs, anthropic.NewAssistantMessage(anthropic.NewTextBlock(m.Content)))
		}
	}

	params := anthropic.MessageNewParams{
		Model:     anthropic.Model(req.Model),
		MaxTokens: maxTokens,
		System: []anthropic.TextBlockParam{
			{Text: req.System},
		},
		Messages: msgs,
	}

	ch := make(chan Event, 64)
	go func() {
		defer close(ch)

		stream := a.client.Messages.NewStreaming(ctx, params)
		defer stream.Close()

		usage := UsageEvent{}
		for stream.Next() {
			switch ev := stream.Current().AsAny().(type) {
			case anthropic.ContentBlockDeltaEvent:
				if td, ok := ev.Delta.AsAny().(anthropic.TextDelta); ok && td.Text != "" {
					ch <- TextDeltaEvent{Text: td.Text}
				}
			case anthropic.MessageStartEvent:
				usage.InputTokens = ev.Message.Usage.InputTokens
			case anthropic.MessageDeltaEvent:
				usage.OutputTokens = ev.Usage.OutputTokens
			}
		}
		if err := stream.Err(); err != nil {
			ch <- ErrorEvent{Err: err}
			return
		}
		if usage.InputTokens > 0 || usage.OutputTokens > 0 {
			ch <- usage
		}
		ch <- DoneEvent{}
	}()

	return ch, nil
}
