package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
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
	// failures, no content emitted yet); retryBase seeds its backoff and
	// retryBudget caps the wall clock retries may consume. Defaults come
	// from DefaultMaxRetries / baseRetryDelay / DefaultRetryBudget; tests
	// shrink them.
	retries     int
	retryBase   time.Duration
	retryBudget time.Duration
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
	// The SDK's own retry (2 attempts on any 5xx) is disabled: khode's
	// retry loop is the single policy layer, and the SDK re-sending a
	// request that just spent a minute timing out at the gateway is how
	// one failed turn used to pin "working" for many minutes.
	opts = append(opts, option.WithMaxRetries(0))
	client := openai.NewClient(opts...)
	return &OpenAI{client: &client, name: name, retries: DefaultMaxRetries,
		retryBase: baseRetryDelay, retryBudget: DefaultRetryBudget}
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
			// Thinking is display-only; strip legacy <think> tags so old
			// transcripts never replay reasoning as answer content.
			content := StripThinkTags(m.Content)
			if len(m.ToolCalls) == 0 {
				if content != "" {
					msgs = append(msgs, openai.AssistantMessage(content))
				}
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
			if content != "" {
				am.Content = openai.ChatCompletionAssistantMessageParamContentUnion{
					OfString: openai.Opt(content),
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
		// forwarded and the wall clock is inside the retry budget — after
		// the first content event a retry would duplicate output, and once
		// the budget is spent the error surfaces instead of stacking
		// minute-long upstream timeouts into silent "working". Each retry
		// is announced so the turn is not a black box while it waits.
		emitted := false
		started := time.Now()
		for attempt := 0; ; attempt++ {
			usage, err := o.streamAttempt(ctx, params, ch, &emitted)
			if err == nil {
				if usage.InputTokens > 0 || usage.OutputTokens > 0 {
					ch <- usage
				}
				ch <- DoneEvent{}
				return
			}
			if !emitted && attempt < o.retries && openaiRetryable(err) &&
				time.Since(started) <= o.retryBudget {
				ch <- RetryEvent{Attempt: attempt + 2, Max: o.retries + 1, Err: err}
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
// usage on a clean stream end, or the stream error. The attempt rides
// its own context: the stall guard cancels it when no SSE event arrives
// within streamStallLimit, bounding how long a dead upstream can hang
// the turn.
func (o *OpenAI) streamAttempt(ctx context.Context, params openai.ChatCompletionNewParams, ch chan<- Event, emitted *bool) (UsageEvent, error) {
	attemptCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	stall := newStallGuard(cancel, streamStallLimit)
	defer stall.stop()

	stream := o.client.Chat.Completions.NewStreaming(attemptCtx, params)
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

	// Content deltas are run through a <think> splitter so inline
	// reasoning (DeepSeek, Ollama, proxies) never lands in the answer.
	var sp thinkSplitter

	usage := UsageEvent{}
	for stream.Next() {
		stall.progress()
		chunk := stream.Current()
		for _, choice := range chunk.Choices {
			if rc := reasoningContent(choice.Delta); rc != "" {
				*emitted = true
				ch <- ThinkingDeltaEvent{Text: rc}
			}
			if choice.Delta.Content != "" {
				answer, think := sp.Feed(choice.Delta.Content)
				if think != "" {
					*emitted = true
					ch <- ThinkingDeltaEvent{Text: think}
				}
				if answer != "" {
					*emitted = true
					ch <- TextDeltaEvent{Text: answer}
				}
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
	// A canceled attempt context is either the stall guard (turn still
	// alive) or the user's abort; neither is retryable, and the SDK's
	// transport view of both is an opaque error — surface the real one.
	if aerr := attemptCtx.Err(); aerr != nil {
		if ctx.Err() != nil {
			return UsageEvent{}, ctx.Err()
		}
		return UsageEvent{}, stalledErr()
	}
	if err := stream.Err(); err != nil {
		return UsageEvent{}, err
	}
	// A held-back tag fragment that never resolved is literal text of
	// whatever phase the stream was in.
	if answer, think := sp.Flush(); answer != "" || think != "" {
		*emitted = true
		if think != "" {
			ch <- ThinkingDeltaEvent{Text: think}
		} else {
			ch <- TextDeltaEvent{Text: answer}
		}
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

// reasoningContent extracts the DeepSeek-style `reasoning_content` delta
// field from the raw JSON: openai-go v1.12 does not model the extension,
// but it preserves every delta's raw bytes and lists unknown fields.
func reasoningContent(delta openai.ChatCompletionChunkChoiceDelta) string {
	if _, ok := delta.JSON.ExtraFields["reasoning_content"]; !ok {
		return ""
	}
	var ext struct {
		ReasoningContent string `json:"reasoning_content"`
	}
	if err := json.Unmarshal([]byte(delta.RawJSON()), &ext); err != nil {
		return ""
	}
	return ext.ReasoningContent
}

// openaiRetryable classifies stream errors: API errors by status code,
// transport-shaped errors by network heuristics. A quota-exhausted rate
// limit is a verdict, not a delay — it never retries.
func openaiRetryable(err error) bool {
	var apiErr *openai.Error
	if errors.As(err, &apiErr) {
		if apiErr.StatusCode == http.StatusTooManyRequests && quotaExhausted(err) {
			return false
		}
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
