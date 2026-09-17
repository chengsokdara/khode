package llm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/anthropics/anthropic-sdk-go"
	"github.com/anthropics/anthropic-sdk-go/option"
)

// Anthropic implements Provider against the official Anthropic SDK.
// It reads ANTHROPIC_API_KEY from the environment.
type Anthropic struct {
	client *anthropic.Client
	// retries is the number of repeats after a failed attempt (transient
	// failures, no content emitted yet); retryBase seeds its backoff.
	// Defaults come from DefaultMaxRetries / baseRetryDelay; tests shrink
	// them.
	retries   int
	retryBase time.Duration
}

// NewAnthropic builds an Anthropic provider with default environment auth.
func NewAnthropic() *Anthropic { return NewAnthropicWithKey("", "") }

// NewAnthropicWithKey builds an Anthropic provider authenticated with an
// explicit key and endpoint; empty values fall back to the SDK's
// environment lookup (ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL).
func NewAnthropicWithKey(key, baseURL string) *Anthropic {
	var opts []option.RequestOption
	if key != "" {
		opts = append(opts, option.WithAPIKey(key))
	}
	if baseURL != "" {
		opts = append(opts, option.WithBaseURL(baseURL))
	}
	client := anthropic.NewClient(opts...)
	return &Anthropic{client: &client, retries: DefaultMaxRetries, retryBase: baseRetryDelay}
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
			blocks := make([]anthropic.ContentBlockParamUnion, 0, len(m.ToolCalls)+1)
			if m.Content != "" {
				blocks = append(blocks, anthropic.NewTextBlock(m.Content))
			}
			for _, c := range m.ToolCalls {
				input := c.Input
				if len(input) == 0 {
					input = json.RawMessage("{}")
				}
				blocks = append(blocks, anthropic.NewToolUseBlock(c.ID, input, c.Name))
			}
			msgs = append(msgs, anthropic.NewAssistantMessage(blocks...))
		case RoleTool:
			r := m.ToolResult
			if r == nil {
				continue
			}
			msgs = append(msgs, anthropic.NewUserMessage(
				anthropic.NewToolResultBlock(r.CallID, r.Content, r.IsError)))
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
	for _, t := range req.Tools {
		tool := anthropic.ToolParam{Name: t.Name}
		if t.Description != "" {
			tool.Description = anthropic.Opt(t.Description)
		}
		if len(t.Parameters) > 0 {
			if err := json.Unmarshal(t.Parameters, &tool.InputSchema); err != nil {
				return nil, fmt.Errorf("tool %q schema: %w", t.Name, err)
			}
		}
		params.Tools = append(params.Tools, anthropic.ToolUnionParam{OfTool: &tool})
	}

	ch := make(chan Event, 64)
	go func() {
		defer close(ch)

		// Transient failures are retried only while nothing has been
		// forwarded — after the first content event a retry would
		// duplicate output, so those errors surface unchanged.
		emitted := false
		for attempt := 0; ; attempt++ {
			usage, err := a.streamAttempt(ctx, params, ch, &emitted)
			if err == nil {
				if usage.InputTokens > 0 || usage.OutputTokens > 0 {
					ch <- usage
				}
				ch <- DoneEvent{}
				return
			}
			if !emitted && attempt < a.retries && anthropicRetryable(err) {
				if !backoffSleep(ctx, retryDelay(attempt, retryAfterOf(err), a.retryBase)) {
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
func (a *Anthropic) streamAttempt(ctx context.Context, params anthropic.MessageNewParams, ch chan<- Event, emitted *bool) (UsageEvent, error) {
	stream := a.client.Messages.NewStreaming(ctx, params)
	defer stream.Close()

	// Tool inputs arrive as partial JSON deltas keyed by block index;
	// each completed block becomes one ToolCallEvent.
	type toolBuild struct {
		id, name string
		input    strings.Builder
	}
	builds := map[int64]*toolBuild{}

	usage := UsageEvent{}
	for stream.Next() {
		switch ev := stream.Current().AsAny().(type) {
		case anthropic.ContentBlockStartEvent:
			if tb, ok := ev.ContentBlock.AsAny().(anthropic.ToolUseBlock); ok {
				builds[ev.Index] = &toolBuild{id: tb.ID, name: tb.Name}
			}
		case anthropic.ContentBlockDeltaEvent:
			switch d := ev.Delta.AsAny().(type) {
			case anthropic.TextDelta:
				if d.Text != "" {
					*emitted = true
					ch <- TextDeltaEvent{Text: d.Text}
				}
			case anthropic.InputJSONDelta:
				if b := builds[ev.Index]; b != nil {
					b.input.WriteString(d.PartialJSON)
				}
			}
		case anthropic.ContentBlockStopEvent:
			if b := builds[ev.Index]; b != nil {
				input := []byte(b.input.String())
				if len(input) == 0 {
					input = json.RawMessage("{}")
				}
				*emitted = true
				ch <- ToolCallEvent{ToolCall{ID: b.id, Name: b.name, Input: input}}
				delete(builds, ev.Index)
			}
		case anthropic.MessageStartEvent:
			usage.InputTokens = ev.Message.Usage.InputTokens
		case anthropic.MessageDeltaEvent:
			usage.OutputTokens = ev.Usage.OutputTokens
		}
	}
	if err := stream.Err(); err != nil {
		return UsageEvent{}, err
	}
	return usage, nil
}

// anthropicRetryable classifies stream errors: API errors by status code,
// transport-shaped errors by network heuristics.
func anthropicRetryable(err error) bool {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) {
		return retryableStatus(apiErr.StatusCode)
	}
	return retryableNet(err)
}

// retryAfterOf returns the failed response's Retry-After header, if any.
func retryAfterOf(err error) string {
	var apiErr *anthropic.Error
	if errors.As(err, &apiErr) && apiErr.Response != nil {
		return apiErr.Response.Header.Get("Retry-After")
	}
	return ""
}
