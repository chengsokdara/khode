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
