package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/openai/openai-go"
	"github.com/openai/openai-go/option"
	"github.com/openai/openai-go/shared"
)

// OpenAI implements Provider against the official OpenAI SDK.
// It reads OPENAI_API_KEY from the environment.
type OpenAI struct {
	client *openai.Client
	// name overrides Name() for custom providers that speak this
	// protocol under their own name; empty reports "openai".
	name string
	// retries is the number of repeats after a failed attempt (transient
	// failures, no content emitted yet); retryBase seeds its backoff.
	// Defaults come from DefaultMaxRetries / baseRetryDelay; tests shrink
	// them.
	retries   int
	retryBase time.Duration
}

// NewOpenAI builds an OpenAI provider with default environment auth.
func NewOpenAI() *OpenAI { return NewOpenAIWithKey("", "") }

// NewOpenAIWithKey builds an OpenAI provider authenticated with an
// explicit key and endpoint; empty values fall back to the SDK's
// environment lookup (OPENAI_API_KEY / OPENAI_BASE_URL).
func NewOpenAIWithKey(key, baseURL string) *OpenAI {
	return newOpenAIClient(key, baseURL, "")
}

// newOpenAIClient is the constructor behind both built-in and custom
// providers that speak the OpenAI protocol.
func newOpenAIClient(key, baseURL, name string) *OpenAI {
	var opts []option.RequestOption
	if key != "" {
		opts = append(opts, option.WithAPIKey(key))
	}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	client := openai.NewClient(opts...)
	return &OpenAI{client: &client, name: name, retries: DefaultMaxRetries, retryBase: baseRetryDelay}
}

func (o *OpenAI) Name() string {
	if o.name != "" {
		return o.name
	}
	return "openai"
}

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

		// Transient failures are retried only while nothing has been
		// forwarded — after the first content event a retry would
		// duplicate output, so those errors surface unchanged.
		emitted := false
		for attempt := 0; ; attempt++ {
			usage, err := o.streamAttempt(ctx, params, ch, &emitted)
			if err == nil {
				if usage.InputTokens > 0 || usage.OutputTokens > 0 {
					ch <- usage
				}
				ch <- DoneEvent{}
				return
			}
			if !emitted && attempt < o.retries && openaiRetryable(err) {
				if !backoffSleep(ctx, retryDelay(attempt, retryAfterOfOpenAI(err), o.retryBase)) {
					ch <- ErrorEvent{Err: ctx.Err()}
					return
				}
				continue
			}
			ch <- ErrorEvent{Err: err}
			return
		}
	}()

	return ch, nil
}

// streamAttempt runs one streaming attempt, forwarding content events to
// ch as they arrive (which marks *emitted). It returns the accumulated
// usage on a clean stream end, or the stream error.
func (o *OpenAI) streamAttempt(ctx context.Context, params openai.ChatCompletionNewParams, ch chan<- Event, emitted *bool) (UsageEvent, error) {
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
				*emitted = true
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
		return UsageEvent{}, err
	}
	sort.Slice(order, func(i, j int) bool { return order[i] < order[j] })
	for _, idx := range order {
		b := calls[idx]
		input := []byte(b.args.String())
		if len(input) == 0 {
			input = json.RawMessage("{}")
		}
		*emitted = true
		ch <- ToolCallEvent{ToolCall{ID: b.id, Name: b.name, Input: input}}
	}
	return usage, nil
}

// openaiRetryable classifies stream errors: API errors by status code,
// transport-shaped errors by network heuristics.
func openaiRetryable(err error) bool {
	var apiErr *openai.Error
	if errors.As(err, &apiErr) {
		return retryableStatus(apiErr.StatusCode)
	}
	return retryableNet(err)
}

// retryAfterOfOpenAI returns the failed response's Retry-After header,
// if any.
func retryAfterOfOpenAI(err error) string {
	var apiErr *openai.Error
	if errors.As(err, &apiErr) && apiErr.Response != nil {
		return apiErr.Response.Header.Get("Retry-After")
	}
	return ""
}
