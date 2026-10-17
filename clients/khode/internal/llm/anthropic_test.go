package llm

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// The fake server answers one messages stream in Anthropic SSE format:
// message_start (input usage), two text deltas, message_delta (output
// usage), then message_stop.
func anthropicFakeServer(t *testing.T, gotBody *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		*gotBody = body

		w.Header().Set("Content-Type", "text/event-stream")
		send := func(event string, v any) {
			data, _ := json.Marshal(v)
			w.Write([]byte("event: " + event + "\ndata: " + string(data) + "\n\n"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		send("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": "msg_1", "type": "message", "role": "assistant",
				"content": []any{}, "model": "claude-test",
				"usage": map[string]any{"input_tokens": 10, "output_tokens": 0},
			},
		})
		send("content_block_start", map[string]any{
			"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": "khode"},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": " rocks"},
		})
		send("content_block_stop", map[string]any{
			"type": "content_block_stop", "index": 0,
		})
		send("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"output_tokens": 5},
		})
		send("message_stop", map[string]any{"type": "message_stop"})
	}))
}

func TestAnthropicStream(t *testing.T) {
	var body map[string]any
	srv := anthropicFakeServer(t, &body)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()

	ch, err := p.Stream(t.Context(), Request{
		System:    "You are terse.",
		Model:     "claude-test",
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

	// The wire request must carry the model, the token cap, the system
	// prompt as a text block, and every conversation turn in order.
	if body["model"] != "claude-test" {
		t.Errorf("model = %v, want claude-test", body["model"])
	}
	if body["max_tokens"] != float64(32) {
		t.Errorf("max_tokens = %v, want 32", body["max_tokens"])
	}
	sys, _ := body["system"].([]any)
	if len(sys) != 1 {
		t.Fatalf("got %d system blocks, want 1", len(sys))
	}
	if s, _ := sys[0].(map[string]any)["text"].(string); s != "You are terse." {
		t.Errorf("system text = %q", s)
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 turns", len(msgs))
	}
	wantRoles := []string{"user", "assistant", "user"}
	for i, m := range msgs {
		role, _ := m.(map[string]any)["role"].(string)
		if role != wantRoles[i] {
			t.Errorf("messages[%d].role = %q, want %q", i, role, wantRoles[i])
		}
	}
	first, _ := msgs[0].(map[string]any)["content"].([]any)
	if len(first) != 1 {
		t.Fatalf("messages[0].content has %d blocks, want 1", len(first))
	}
	if c, _ := first[0].(map[string]any)["text"].(string); c != "hi" {
		t.Errorf("messages[0] text = %q, want %q", c, "hi")
	}
}

// The fake server streams a tool_use block: content_block_start carries the
// id and name, two input_json_delta fragments carry the arguments.
func anthropicToolServer(t *testing.T, gotBody *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		*gotBody = body

		w.Header().Set("Content-Type", "text/event-stream")
		send := func(event string, v any) {
			data, _ := json.Marshal(v)
			w.Write([]byte("event: " + event + "\ndata: " + string(data) + "\n\n"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		send("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": "msg_2", "type": "message", "role": "assistant",
				"content": []any{}, "model": "claude-test",
				"usage": map[string]any{"input_tokens": 7, "output_tokens": 0},
			},
		})
		send("content_block_start", map[string]any{
			"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "tool_use", "id": "toolu_9", "name": "read", "input": map[string]any{}},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": "{\"path\":"},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "input_json_delta", "partial_json": "\"a.go\"}"},
		})
		send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		send("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": "tool_use"},
			"usage": map[string]any{"output_tokens": 3},
		})
		send("message_stop", map[string]any{"type": "message_stop"})
	}))
}

func TestAnthropicToolCallStream(t *testing.T) {
	var body map[string]any
	srv := anthropicToolServer(t, &body)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()

	// The history includes a previous tool exchange so the request-body
	// assertions cover assistant tool_use and tool_result serialization.
	ch, err := p.Stream(t.Context(), Request{
		Model:     "claude-test",
		MaxTokens: 32,
		Messages: []Message{
			{Role: RoleUser, Content: "read a.go"},
			{Role: RoleAssistant, ToolCalls: []ToolCall{
				{ID: "toolu_1", Name: "read", Input: json.RawMessage(`{"path":"a.go"}`)},
			}},
			{Role: RoleTool, ToolResult: &ToolResult{CallID: "toolu_1", Content: "package a", IsError: false}},
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
	sawDone := false
	for ev := range ch {
		switch e := ev.(type) {
		case ToolCallEvent:
			calls = append(calls, e)
		case UsageEvent:
			if e.InputTokens != 7 || e.OutputTokens != 3 {
				t.Errorf("usage = (%d, %d), want (7, 3)", e.InputTokens, e.OutputTokens)
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
	if !sawDone {
		t.Error("channel closed without DoneEvent")
	}
	if len(calls) != 1 {
		t.Fatalf("got %d tool calls, want 1", len(calls))
	}
	c := calls[0].ToolCall
	if c.ID != "toolu_9" || c.Name != "read" {
		t.Errorf("tool call = (%q, %q), want (toolu_9, read)", c.ID, c.Name)
	}
	if string(c.Input) != `{"path":"a.go"}` {
		t.Errorf("tool input = %s, want {\"path\":\"a.go\"}", c.Input)
	}

	// The wire request advertises the tool and replays the prior tool
	// exchange as native blocks.
	tools, _ := body["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("got %d tools, want 1", len(tools))
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "read" {
		t.Errorf("tools[0].name = %v, want read", tool["name"])
	}
	schema, _ := tool["input_schema"].(map[string]any)
	if schema == nil || schema["type"] != "object" {
		t.Errorf("tools[0].input_schema = %v, want object schema", tool["input_schema"])
	}
	if desc, _ := tool["description"].(string); desc != "Read a file" {
		t.Errorf("tools[0].description = %v, want %q", tool["description"], "Read a file")
	}
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 turns", len(msgs))
	}
	assistant, _ := msgs[1].(map[string]any)["content"].([]any)
	if len(assistant) != 1 {
		t.Fatalf("assistant turn has %d blocks, want 1", len(assistant))
	}
	use, _ := assistant[0].(map[string]any)
	if use["type"] != "tool_use" || use["id"] != "toolu_1" || use["name"] != "read" {
		t.Errorf("assistant block = %v, want tool_use toolu_1 read", use)
	}
	result, _ := msgs[2].(map[string]any)["content"].([]any)
	if len(result) != 1 {
		t.Fatalf("tool turn has %d blocks, want 1", len(result))
	}
	res, _ := result[0].(map[string]any)
	if res["type"] != "tool_result" || res["tool_use_id"] != "toolu_1" {
		t.Errorf("result block = %v, want tool_result for toolu_1", res)
	}
}

// The fake server streams a thinking block followed by a text block,
// the shape extended-thinking responses use.
func anthropicThinkServer(t *testing.T, gotBody *map[string]any) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decoding request: %v", err)
			return
		}
		*gotBody = body

		w.Header().Set("Content-Type", "text/event-stream")
		send := func(event string, v any) {
			data, _ := json.Marshal(v)
			w.Write([]byte("event: " + event + "\ndata: " + string(data) + "\n\n"))
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		send("message_start", map[string]any{
			"type": "message_start",
			"message": map[string]any{
				"id": "msg_2", "type": "message", "role": "assistant",
				"content": []any{}, "model": "claude-test",
				"usage": map[string]any{"input_tokens": 7, "output_tokens": 0},
			},
		})
		send("content_block_start", map[string]any{
			"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "thinking", "thinking": ""},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": "hmm "},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "thinking_delta", "thinking": "let me see"},
		})
		send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		send("content_block_start", map[string]any{
			"type": "content_block_start", "index": 1,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 1,
			"delta": map[string]any{"type": "text_delta", "text": "the answer"},
		})
		send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 1})
		send("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"output_tokens": 6},
		})
		send("message_stop", map[string]any{"type": "message_stop"})
	}))
}

func TestAnthropicThinkingStream(t *testing.T) {
	var body map[string]any
	srv := anthropicThinkServer(t, &body)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()

	ch, err := p.Stream(t.Context(), Request{
		Model:     "claude-test",
		MaxTokens: 32,
		Messages: []Message{
			{Role: RoleUser, Content: "hi"},
			// Display-only thinking must never replay to the API.
			{Role: RoleAssistant, Content: "earlier", Thinking: "old reasoning"},
			{Role: RoleUser, Content: "go on"},
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
	if thinking != "hmm let me see" {
		t.Errorf("thinking = %q, want %q", thinking, "hmm let me see")
	}
	if answer != "the answer" {
		t.Errorf("answer = %q, want %q", answer, "the answer")
	}

	// The replayed assistant turn carries a single clean text block.
	msgs, _ := body["messages"].([]any)
	if len(msgs) != 3 {
		t.Fatalf("got %d messages, want 3 turns", len(msgs))
	}
	assistant, _ := msgs[1].(map[string]any)
	blocks, _ := assistant["content"].([]any)
	if len(blocks) != 1 {
		t.Fatalf("replayed assistant has %d blocks, want 1", len(blocks))
	}
	if b, _ := blocks[0].(map[string]any); b["type"] != "text" || b["text"] != "earlier" {
		t.Errorf("replayed block = %v, want text/earlier", b)
	}
}
