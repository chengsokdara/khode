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
