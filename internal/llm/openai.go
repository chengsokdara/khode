package llm

import (
	"context"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/shared"
)

// OpenAI implements Provider against the official OpenAI SDK.
// It reads OPENAI_API_KEY from the environment.
type OpenAI struct {
	client *openai.Client
}

// NewOpenAI builds an OpenAI provider with default environment auth.
func NewOpenAI() *OpenAI {
	client := openai.NewClient()
	return &OpenAI{client: &client}
}

func (o *OpenAI) Name() string { return "openai" }

// Stream translates the generic Request into a chat-completions stream
// and forwards deltas over a channel of generic Events.
func (o *OpenAI) Stream(ctx context.Context, req Request) (<-chan Event, error) {
	if req.MaxTokens <= 0 {
		req.MaxTokens = 8192
	}

	msgs := make([]openai.ChatCompletionMessageParamUnion, 0, len(req.Messages)+1)
	if req.System != "" {
		msgs = append(msgs, openai.SystemMessage(req.System))
	}
	for _, m := range req.Messages {
		switch m.Role {
		case RoleUser:
			msgs = append(msgs, openai.UserMessage(m.Content))
		case RoleAssistant:
			msgs = append(msgs, openai.AssistantMessage(m.Content))
		}
	}

	params := openai.ChatCompletionNewParams{
		Model:               shared.ChatModel(req.Model),
		Messages:            msgs,
		MaxCompletionTokens: openai.Int(int64(req.MaxTokens)),
		StreamOptions: openai.ChatCompletionStreamOptionsParam{
			IncludeUsage: openai.Bool(true),
		},
	}

	ch := make(chan Event, 64)
	go func() {
		defer close(ch)

		stream := o.client.Chat.Completions.NewStreaming(ctx, params)
		defer stream.Close()

		// The usage totals arrive on a final chunk with empty Choices, so
		// they are accumulated across chunks and emitted once at the end.
		usage := UsageEvent{}
		for stream.Next() {
			chunk := stream.Current()
			for _, choice := range chunk.Choices {
				if choice.Delta.Content != "" {
					ch <- TextDeltaEvent{Text: choice.Delta.Content}
				}
			}
			if chunk.Usage.PromptTokens > 0 {
				usage.InputTokens = chunk.Usage.PromptTokens
			}
			if chunk.Usage.CompletionTokens > 0 {
				usage.OutputTokens = chunk.Usage.CompletionTokens
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
