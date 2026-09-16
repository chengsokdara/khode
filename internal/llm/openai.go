package llm

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"

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
			if len(m.ToolCalls) == 0 {
				msgs = append(msgs, openai.AssistantMessage(m.Content))
				continue
			}
			calls := make([]openai.ChatCompletionMessageToolCallParam, 0, len(m.ToolCalls))
			for _, c := range m.ToolCalls {
				args := string(c.Input)
				if len(args) == 0 {
					args = "{}"
				}
				calls = append(calls, openai.ChatCompletionMessageToolCallParam{
					ID: c.ID,
					Function: openai.ChatCompletionMessageToolCallFunctionParam{
						Name:      c.Name,
						Arguments: args,
					},
				})
			}
			am := openai.ChatCompletionAssistantMessageParam{ToolCalls: calls}
			if m.Content != "" {
				am.Content = openai.ChatCompletionAssistantMessageParamContentUnion{
					OfString: openai.Opt(m.Content),
				}
			}
			msgs = append(msgs, openai.ChatCompletionMessageParamUnion{OfAssistant: &am})
		case RoleTool:
			if r := m.ToolResult; r != nil {
				msgs = append(msgs, openai.ToolMessage(r.Content, r.CallID))
			}
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
	for _, t := range req.Tools {
		var schema openai.FunctionParameters
		if len(t.Parameters) > 0 {
			if err := json.Unmarshal(t.Parameters, &schema); err != nil {
				return nil, fmt.Errorf("tool %q schema: %w", t.Name, err)
			}
		}
		params.Tools = append(params.Tools, openai.ChatCompletionToolParam{
			Function: shared.FunctionDefinitionParam{
				Name:        t.Name,
				Description: openai.Opt(t.Description),
				Parameters:  schema,
			},
		})
	}

	ch := make(chan Event, 64)
	go func() {
		defer close(ch)

		stream := o.client.Chat.Completions.NewStreaming(ctx, params)
		defer stream.Close()

		// The usage totals arrive on a final chunk with empty Choices, so
		// they are accumulated across chunks and emitted once at the end.
		// Tool calls arrive as fragments keyed by index; each completed
		// call becomes one ToolCallEvent when the stream ends.
		type callBuild struct {
			id, name string
			args     strings.Builder
		}
		var order []int64
		calls := map[int64]*callBuild{}

		usage := UsageEvent{}
		for stream.Next() {
			chunk := stream.Current()
			for _, choice := range chunk.Choices {
				if choice.Delta.Content != "" {
					ch <- TextDeltaEvent{Text: choice.Delta.Content}
				}
				for _, tc := range choice.Delta.ToolCalls {
					b := calls[tc.Index]
					if b == nil {
						b = &callBuild{}
						calls[tc.Index] = b
						order = append(order, tc.Index)
					}
					if tc.ID != "" {
						b.id = tc.ID
					}
					if tc.Function.Name != "" {
						b.name = tc.Function.Name
					}
					b.args.WriteString(tc.Function.Arguments)
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
		sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
		for _, idx := range order {
			b := calls[idx]
			input := []byte(b.args.String())
			if len(input) == 0 {
				input = json.RawMessage("{}")
			}
			ch <- ToolCallEvent{ToolCall{ID: b.id, Name: b.name, Input: input}}
		}
		if usage.InputTokens > 0 || usage.OutputTokens > 0 {
			ch <- usage
		}
		ch <- DoneEvent{}
	}()

	return ch, nil
}
