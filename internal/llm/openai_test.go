package llm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The fake server answers one chat-completions stream: a role chunk, two
// content deltas, a final usage-only chunk, then [DONE].
func openaiFakeServer(t *testing.T, gotBody *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		*gotBody = body

		w.Header().Set("Content-Type", "text/event-stream")
		chunk := func(v any) {
			data, _ := json.Marshal(v)
			w.Write([]byte("data: " + string(data) + "\n\n"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		base := map[string]any{
			"id": "c1", "object": "chat.completion.chunk", "created": 1, "model": "gpt-test",
		}
		empty := map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": nil}
		chunk(merge(base, map[string]any{"choices": []any{empty}}))
		chunk(merge(base, map[string]any{"choices": []any{
			map[string]any{"index": 0, "delta": map[string]any{"content": "khode"}, "finish_reason": nil},
		}}))
		chunk(merge(base, map[string]any{"choices": []any{
			map[string]any{"index": 0, "delta": map[string]any{"content": " rocks"}, "finish_reason": nil},
		}}))
		chunk(merge(base, map[string]any{
			"choices": []any{},
			"usage":   map[string]any{"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
		}))
		w.Write([]byte("data: [DONE]\n\n"))
	}))
}

func merge(base, extra map[string]any) map[string]any {
	m := map[string]any{}
	for k, v := range base {
		m[k] = v
	}
	for k, v := range extra {
		m[k] = v
	}
	return m
}

func TestOpenAIStream(t *testing.T) {
	var body map[string]any
	srv := openaiFakeServer(t, &body)
	defer srv.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_BASE_URL", srv.URL)
	p := NewOpenAI()

	ch, err := p.Stream(t.Context(), Request{
		System:    "You are terse.",
		Model:     "gpt-test",
		MaxTokens: 32,
		Messages: []Message{
			{Role: RoleUser, Content: "hi"},
			{Role: RoleAssistant, Content: "hello"},
			{Role: RoleUser, Content: "say khode rocks"},
		},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	// Drain the stream fully; the fake server records the request when
	// the provider's goroutine issues it.
	var text string
	sawUsage, sawDone := false, false
	for ev := range ch {
		switch e := ev.(type) {
		case TextDeltaEvent:
			text += e.Text
		case UsageEvent:
			sawUsage = true
			if e.InputTokens != 10 || e.OutputTokens != 5 {
				t.Errorf("usage = (%d, %d), want (10, 5)", e.InputTokens, e.OutputTokens)
			}
		case ErrorEvent:
			t.Fatalf("ErrorEvent: %v", e.Err)
		case DoneEvent:
			sawDone = true
		default:
			t.Fatalf("unexpected event type %T", ev)
		}
	}
	if text != "khode rocks" {
		t.Errorf("text = %q, want %q", text, "khode rocks")
	}
	if !sawUsage {
		t.Error("no UsageEvent")
	}
	if !sawDone {
		t.Error("channel closed without DoneEvent")
	}

	// The wire request must carry the model, the system message first,
	// every conversation turn, the token cap, and the usage opt-in.
	if body["model"] != "gpt-test" {
		t.Errorf("model = %v, want gpt-test", body["model"])
	}
	if body["max_completion_tokens"] != float64(32) {
		t.Errorf("max_completion_tokens = %v, want 32", body["max_completion_tokens"])
	}
	if _, ok := body["max_tokens"]; ok {
		t.Errorf("official openai sent max_tokens = %v", body["max_tokens"])
	}
	if _, ok := body["reasoning_effort"]; ok {
		t.Errorf("non-GLM request sent reasoning_effort = %v", body["reasoning_effort"])
	}
	so, _ := body["stream_options"].(map[string]any)
	if so == nil || so["include_usage"] != true {
		t.Errorf("stream_options.include_usage = %v, want true", body["stream_options"])
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 4 {
		t.Fatalf("got %d messages, want 4 (system + 3 turns)", len(msgs))
	}
	wantRoles := []string{"system", "user", "assistant", "user"}
	for i, m := range msgs {
		role, _ := m.(map[string]any)["role"].(string)
		if role != wantRoles[i] {
			t.Errorf("messages[%d].role = %q, want %q", i, role, wantRoles[i])
		}
	}
	if sys, _ := msgs[0].(map[string]any)["content"].(string); sys != "You are terse." {
		t.Errorf("system content = %q", sys)
	}
}

// The fake server streams one tool call split across three chunks: id and
// name first, then two argument fragments, then finish_reason tool_calls.
func openaiToolServer(t *testing.T, gotBody *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		*gotBody = body

		w.Header().Set("Content-Type", "text/event-stream")
		chunk := func(v any) {
			data, _ := json.Marshal(v)
			w.Write([]byte("data: " + string(data) + "\n\n"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		base := map[string]any{
			"id": "c2", "object": "chat.completion.chunk", "created": 1, "model": "gpt-test",
		}
		toolDelta := func(delta map[string]any) {
			chunk(merge(base, map[string]any{"choices": []any{
				map[string]any{"index": 0, "delta": map[string]any{"tool_calls": []any{delta}}, "finish_reason": nil},
			}}))
		}
		toolDelta(map[string]any{"index": 0, "id": "call_9", "type": "function",
			"function": map[string]any{"name": "read", "arguments": ""}})
		toolDelta(map[string]any{"index": 0,
			"function": map[string]any{"arguments": "{\"path\":"}})
		toolDelta(map[string]any{"index": 0,
			"function": map[string]any{"arguments": "\"a.go\"}"}})
		chunk(merge(base, map[string]any{"choices": []any{
			map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"},
		}}))
		chunk(merge(base, map[string]any{
			"choices": []any{},
			"usage":   map[string]any{"prompt_tokens": 6, "completion_tokens": 2, "total_tokens": 8},
		}))
		w.Write([]byte("data: [DONE]\n\n"))
	}))
}

func TestOpenAIToolCallStream(t *testing.T) {
	var body map[string]any
	srv := openaiToolServer(t, &body)
	defer srv.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_BASE_URL", srv.URL)
	p := NewOpenAI()

	ch, err := p.Stream(t.Context(), Request{
		Model:     "gpt-test",
		MaxTokens: 32,
		Messages: []Message{
			{Role: RoleUser, Content: "read a.go"},
			{Role: RoleAssistant, Content: "checking", ToolCalls: []ToolCall{
				{ID: "call_1", Name: "read", Input: json.RawMessage(`{"path":"a.go"}`)},
			}},
			{Role: RoleTool, ToolResult: &ToolResult{CallID: "call_1", Content: "package a", IsError: true}},
		},
		Tools: []ToolDef{{
			Name:        "read",
			Description: "Read a file",
			Parameters:  json.RawMessage(`{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}`),
		}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	var calls []ToolCallEvent
	sawUsage, sawDone := false, false
	for ev := range ch {
		switch e := ev.(type) {
		case ToolCallEvent:
			calls = append(calls, e)
		case UsageEvent:
			sawUsage = true
			if e.InputTokens != 6 || e.OutputTokens != 2 {
				t.Errorf("usage = (%d, %d), want (6, 2)", e.InputTokens, e.OutputTokens)
			}
		case ErrorEvent:
			t.Fatalf("ErrorEvent: %v", e.Err)
		case DoneEvent:
			sawDone = true
		case TextDeltaEvent:
			t.Errorf("unexpected text delta %q", e.Text)
		default:
			t.Fatalf("unexpected event type %T", ev)
		}
	}
	if !sawUsage || !sawDone {
		t.Fatalf("sawUsage=%v sawDone=%v, want both true", sawUsage, sawDone)
	}
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	c := calls[0].ToolCall
	if c.ID != "call_9" || c.Name != "read" {
		t.Errorf("tool call = (%q, %q), want (call_9, read)", c.ID, c.Name)
	}
	if string(c.Input) != `{"path":"a.go"}` {
		t.Errorf("tool input = %s, want {\"path\":\"a.go\"}", c.Input)
	}

	// The wire request advertises the tool under "tools" and replays the
	// prior exchange as assistant tool_calls plus a role-"tool" message.
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(tools))
	}
	tool, _ := tools[0].(map[string]any)
	fn, _ := tool["function"].(map[string]any)
	if tool["type"] != "function" || fn == nil || fn["name"] != "read" {
		t.Errorf("tools[0] = %v, want function/read", tools[0])
	}
	params, _ := fn["parameters"].(map[string]any)
	if params == nil || params["type"] != "object" {
		t.Errorf("tools[0].function.parameters = %v, want object schema", fn["parameters"])
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 turns", len(msgs))
	}
	assistant, _ := msgs[1].(map[string]any)
	wireCalls, _ := assistant["tool_calls"].([]any)
	if len(wireCalls) != 1 {
		t.Fatalf("assistant turn has %v tool_calls, want 1", assistant["tool_calls"])
	}
	call, _ := wireCalls[0].(map[string]any)
	if call["id"] != "call_1" {
		t.Errorf("assistant tool_call id = %v, want call_1", call["id"])
	}
	if c, _ := assistant["content"].(string); c != "checking" {
		t.Errorf("assistant content = %v, want checking", assistant["content"])
	}
	toolMsg, _ := msgs[2].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_1" {
		t.Errorf("tool message = %v, want role tool for call_1", toolMsg)
	}
}

// The fake server streams reasoning the way DeepSeek-style endpoints do:
// a `reasoning_content` delta, then inline <think> tags in the content,
// split so the closing tag straddles two chunks.
func openaiThinkServer(t *testing.T, gotBody *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		*gotBody = body

		w.Header().Set("Content-Type", "text/event-stream")
		chunk := func(v any) {
			data, _ := json.Marshal(v)
			w.Write([]byte("data: " + string(data) + "\n\n"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		base := map[string]any{
			"id": "c3", "object": "chat.completion.chunk", "created": 1, "model": "gpt-test",
		}
		delta := func(d map[string]any) {
			chunk(merge(base, map[string]any{"choices": []any{
				map[string]any{"index": 0, "delta": d, "finish_reason": nil},
			}}))
		}
		delta(map[string]any{"role": "assistant"})
		delta(map[string]any{"reasoning_content": "ponder "})
		delta(map[string]any{"content": "<think>more "})
		delta(map[string]any{"content": "thought</thi"})
		delta(map[string]any{"content": "nk>Answer "})
		delta(map[string]any{"content": "text"})
		chunk(merge(base, map[string]any{"choices": []any{}, "usage": map[string]any{"prompt_tokens": 4, "completion_tokens": 9}}))
		w.Write([]byte("data: [DONE]\n\n"))
	}))
}

func TestOpenAIThinkingStream(t *testing.T) {
	var body map[string]any
	srv := openaiThinkServer(t, &body)
	defer srv.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_BASE_URL", srv.URL)
	p := NewOpenAI()

	ch, err := p.Stream(t.Context(), Request{
		Model:     "gpt-test",
		MaxTokens: 32,
		Messages: []Message{
			{Role: RoleUser, Content: "hi"},
			// Legacy transcript content with tags must be stripped on
			// replay so the reasoning never goes back to the provider.
			{Role: RoleAssistant, Content: "<think>old</think>kept"},
			{Role: RoleUser, Content: "think then answer"},
		},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}

	var answer, thinking string
	sawDone := false
	for ev := range ch {
		switch e := ev.(type) {
		case TextDeltaEvent:
			answer += e.Text
		case ThinkingDeltaEvent:
			thinking += e.Text
		case UsageEvent:
		case ErrorEvent:
			t.Fatalf("ErrorEvent: %v", e.Err)
		case DoneEvent:
			sawDone = true
		default:
			t.Fatalf("unexpected event type %T", ev)
		}
	}
	if !sawDone {
		t.Error("channel closed without DoneEvent")
	}
	if thinking != "ponder more thought" {
		t.Errorf("thinking = %q, want %q", thinking, "ponder more thought")
	}
	if answer != "Answer text" {
		t.Errorf("answer = %q, want %q", answer, "Answer text")
	}

	// The replayed assistant turn carries clean content, no tags.
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 turns", len(msgs))
	}
	assistant, _ := msgs[1].(map[string]any)
	if c, _ := assistant["content"].(string); c != "kept" {
		t.Errorf("replayed assistant content = %q, want %q", c, "kept")
	}
	if _, ok := assistant["reasoning_content"]; ok {
		t.Errorf("empty thinking replayed reasoning_content = %v", assistant["reasoning_content"])
	}
}

// GLM tool turns must send the original reasoning_content back, use
// max_tokens (NIM's field), and default the effort and output cap.
func TestOpenAIGLMToolReplay(t *testing.T) {
	var body map[string]any
	srv := openaiFakeServer(t, &body)
	defer srv.Close()

	p := newOpenAIClient("test-key", srv.URL, "khateway")
	ch, err := p.Stream(t.Context(), Request{
		Model:     "z-ai-glm-5.3-flash",
		MaxTokens: defaultRequestMaxTokens,
		Messages: []Message{
			{Role: RoleUser, Content: "edit main.go"},
			{Role: RoleAssistant, Content: "looking", Thinking: "plan the edit", ToolCalls: []ToolCall{
				{ID: "call_1", Name: "read", Input: json.RawMessage(`{"path":"main.go"}`)},
			}},
			{Role: RoleTool, ToolResult: &ToolResult{CallID: "call_1", Content: "package main"}},
		},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	for ev := range ch {
		if e, ok := ev.(ErrorEvent); ok {
			t.Fatalf("ErrorEvent: %v", e.Err)
		}
	}

	if body["max_tokens"] != float64(glm53DefaultMaxTokens) {
		t.Errorf("max_tokens = %v, want %d", body["max_tokens"], glm53DefaultMaxTokens)
	}
	if _, ok := body["max_completion_tokens"]; ok {
		t.Errorf("khateway sent max_completion_tokens = %v", body["max_completion_tokens"])
	}
	if body["reasoning_effort"] != "high" {
		t.Errorf("reasoning_effort = %v, want high", body["reasoning_effort"])
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3", len(msgs))
	}
	assistant, _ := msgs[1].(map[string]any)
	if assistant["reasoning_content"] != "plan the edit" {
		t.Errorf("reasoning_content = %v, want the stored trace", assistant["reasoning_content"])
	}
	if assistant["content"] != "looking" {
		t.Errorf("content = %v, want looking", assistant["content"])
	}
	calls, _ := assistant["tool_calls"].([]any)
	if len(calls) != 1 {
		t.Fatalf("tool_calls = %d, want 1", len(calls))
	}

	// An explicit cap and effort win over the GLM defaults.
	body = nil
	ch, err = p.Stream(t.Context(), Request{
		Model:           "glm-5.3",
		MaxTokens:       1000,
		ReasoningEffort: "max",
		Messages:        []Message{{Role: RoleUser, Content: "hi"}},
	})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	for ev := range ch {
		if e, ok := ev.(ErrorEvent); ok {
			t.Fatalf("ErrorEvent: %v", e.Err)
		}
	}
	if body["max_tokens"] != float64(1000) {
		t.Errorf("explicit max_tokens = %v, want 1000", body["max_tokens"])
	}
	if body["reasoning_effort"] != "max" {
		t.Errorf("explicit reasoning_effort = %v, want max", body["reasoning_effort"])
	}
}
