package llm

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// anthropicFlakyServer answers the first n requests with code (Retry-After
// included) and then serves a valid one-text-delta stream. The request
// count is exposed through the returned pointer.
func anthropicFlakyServer(t *testing.T, code int, retryAfter string, n int, requests *int) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		*requests++
		if *requests <= n {
			if retryAfter != "" {
				w.Header().Set("Retry-After", retryAfter)
			}
			w.WriteHeader(code)
			w.Write([]byte(`{"error":{"type":"overloaded_error","message":"try again"}}`))
			return
		}

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
				"id": "msg_r", "type": "message", "role": "assistant",
				"content": []any{}, "model": "claude-test",
				"usage": map[string]any{"input_tokens": 3, "output_tokens": 0},
			},
		})
		send("content_block_start", map[string]any{
			"type": "content_block_start", "index": 0,
			"content_block": map[string]any{"type": "text", "text": ""},
		})
		send("content_block_delta", map[string]any{
			"type": "content_block_delta", "index": 0,
			"delta": map[string]any{"type": "text_delta", "text": "ok"},
		})
		send("content_block_stop", map[string]any{"type": "content_block_stop", "index": 0})
		send("message_delta", map[string]any{
			"type":  "message_delta",
			"delta": map[string]any{"stop_reason": "end_turn"},
			"usage": map[string]any{"output_tokens": 1},
		})
		send("message_stop", map[string]any{"type": "message_stop"})
	}))
}

// TestAnthropicRetriesTransientStatus: a 429 (then success) must be
// retried transparently, with Retry-After honored for the wait. Each
// retry is announced with a RetryEvent.
func TestAnthropicRetriesTransientStatus(t *testing.T) {
	requests := 0
	srv := anthropicFlakyServer(t, http.StatusTooManyRequests, "0", 2, &requests)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "claude-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	var text string
	sawDone := false
	var retries []RetryEvent
	for ev := range ch {
		switch e := ev.(type) {
		case TextDeltaEvent:
			text += e.Text
		case RetryEvent:
			retries = append(retries, e)
		case ErrorEvent:
			t.Fatalf("unexpected ErrorEvent after retries: %v", e.Err)
		case DoneEvent:
			sawDone = true
		}
	}
	if !sawDone || text != "ok" {
		t.Errorf("text=%q done=%v, want ok/true", text, sawDone)
	}
	if requests < 2 {
		t.Errorf("server saw %d requests, want at least the retry", requests)
	}
	if len(retries) != 2 || retries[0].Attempt != 2 || retries[1].Attempt != 3 ||
		retries[0].Max != 5 || retries[0].Err == nil {
		t.Errorf("retries = %+v, want two RetryEvents announcing attempts 2/5 and 3/5", retries)
	}
}

// TestAnthropicNoRetryAfterContent: a failure that lands after content was
// forwarded must surface instead of duplicating output.
func TestAnthropicNoRetryAfterContent(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		// Stream one real delta, then kill the connection mid-response so
		// the SDK reports a truncated body.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Write([]byte("event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"m\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"c\",\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		w.Write([]byte("event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n"))
		w.Write([]byte("event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"visible\"}}\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		conn, buf, err := w.(http.Hijacker).Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		conn.Close()
		buf.Flush()
	}))
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "claude-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	sawErr := false
	for ev := range ch {
		if e, ok := ev.(ErrorEvent); ok {
			sawErr = true
			if e.Err == nil {
				t.Error("ErrorEvent carries nil error")
			}
		}
	}
	if !sawErr {
		t.Error("truncated stream did not produce an ErrorEvent")
	}
	if requests != 1 {
		t.Errorf("server saw %d requests, want 1 (no retry after content)", requests)
	}
}

// TestAnthropicNonRetryableStatus: a 400 must fail immediately.
func TestAnthropicNonRetryableStatus(t *testing.T) {
	requests := 0
	srv := anthropicFlakyServer(t, http.StatusBadRequest, "", 5, &requests)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "claude-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	sawErr := false
	for ev := range ch {
		if _, ok := ev.(ErrorEvent); ok {
			sawErr = true
		}
	}
	if !sawErr {
		t.Error("400 did not produce an ErrorEvent")
	}
	if requests != 1 {
		t.Errorf("server saw %d requests, want 1 (400 is not retryable)", requests)
	}
}

// TestOpenAIRetriesTransientStatus mirrors the Anthropic retry test
// against the chat-completions wire format.
func TestOpenAIRetriesTransientStatus(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if requests <= 1 {
			w.Header().Set("Retry-After", "0")
			w.WriteHeader(http.StatusServiceUnavailable)
			w.Write([]byte(`{"error":{"message":"overloaded"}}`))
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		chunk := `{"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{"content":"ok"}}]}`
		w.Write([]byte("data: " + chunk + "\n\n"))
		final := `{"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-test","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}`
		w.Write([]byte("data: " + final + "\n\n"))
		w.Write([]byte("data: [DONE]\n\n"))
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
	}))
	defer srv.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_BASE_URL", srv.URL)
	p := NewOpenAI()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "gpt-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	var text string
	sawDone := false
	for ev := range ch {
		switch e := ev.(type) {
		case TextDeltaEvent:
			text += e.Text
		case ErrorEvent:
			t.Fatalf("unexpected ErrorEvent after retries: %v", e.Err)
		case DoneEvent:
			sawDone = true
		}
	}
	if !sawDone || text != "ok" {
		t.Errorf("text=%q done=%v, want ok/true", text, sawDone)
	}
	if requests < 2 {
		t.Errorf("server saw %d requests, want at least the retry", requests)
	}
}

func TestRetryDelay(t *testing.T) {
	cases := []struct {
		n          int
		retryAfter string
		base       time.Duration
		want       time.Duration
	}{
		{0, "", 0, 500 * time.Millisecond},
		{1, "", 0, time.Second},
		{3, "", 0, 4 * time.Second},
		{10, "", 0, maxRetryDelay},   // capped
		{0, "2", 0, 2 * time.Second}, // Retry-After wins
		{0, "60", 0, maxRetryDelay},  // Retry-After capped
		{5, " 1 ", 0, time.Second},   // trimmed
		{0, "junk", 0, 500 * time.Millisecond},
		{1, "", 10 * time.Millisecond, 20 * time.Millisecond},
	}
	for _, c := range cases {
		got := retryDelay(c.n, c.retryAfter, c.base)
		if got != c.want {
			t.Errorf("retryDelay(%d, %q, %v) = %v, want %v", c.n, c.retryAfter, c.base, got, c.want)
		}
	}
}

func TestRetryableStatus(t *testing.T) {
	for _, code := range []int{408, 409, 429, 500, 502, 503, 504, 529} {
		if !retryableStatus(code) {
			t.Errorf("%d should be retryable", code)
		}
	}
	for _, code := range []int{400, 401, 403, 404, 422} {
		if retryableStatus(code) {
			t.Errorf("%d should not be retryable", code)
		}
	}
}

func TestBackoffSleepContextCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if backoffSleep(ctx, time.Hour) {
		t.Error("sleep completed despite cancelled context")
	}
}

// TestAnthropicSlowGatewayTimeoutSurfaces: the khateway trap — a gateway
// that answers 504 only after its own long upstream timeout. The first
// attempt spends the whole retry budget, so the error must surface at
// once instead of stacking more minute-long attempts into silent
// "working" (one turn used to hang for many minutes this way).
func TestAnthropicSlowGatewayTimeoutSurfaces(t *testing.T) {
	requests := 0
	srv := anthropicFlakyServer(t, http.StatusGatewayTimeout, "", 99, &requests)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()
	p.retryBase = time.Millisecond
	p.retryBudget = 0 // spent: any elapsed time exceeds it

	ch, err := p.Stream(t.Context(), Request{Model: "claude-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	sawErr := false
	for ev := range ch {
		if e, ok := ev.(ErrorEvent); ok {
			sawErr = true
			if !strings.Contains(e.Err.Error(), "504") && !strings.Contains(e.Err.Error(), "Gateway Timeout") {
				t.Errorf("error = %v, want the gateway timeout", e.Err)
			}
		}
	}
	if !sawErr {
		t.Error("budget-spent 504 did not produce an ErrorEvent")
	}
	if requests != 1 {
		t.Errorf("server saw %d requests, want 1 (budget spent by the slow attempt)", requests)
	}
}

// TestAnthropicFastGatewayTimeoutsStillRetry: with the budget unspent,
// instantly-failing 504s are still retried the full ladder — and the
// request count pins that the SDK's own retry is off (its default would
// double every request here).
func TestAnthropicFastGatewayTimeoutsStillRetry(t *testing.T) {
	requests := 0
	srv := anthropicFlakyServer(t, http.StatusGatewayTimeout, "", 99, &requests)
	defer srv.Close()

	t.Setenv("ANTHROPIC_API_KEY", "test-key")
	t.Setenv("ANTHROPIC_BASE_URL", srv.URL)
	p := NewAnthropic()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "claude-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	sawErr := false
	for ev := range ch {
		if _, ok := ev.(ErrorEvent); ok {
			sawErr = true
		}
	}
	if !sawErr {
		t.Error("504s did not produce an ErrorEvent")
	}
	if requests != DefaultMaxRetries+1 {
		t.Errorf("server saw %d requests, want %d (khode's ladder only — SDK retry must stay off)",
			requests, DefaultMaxRetries+1)
	}
}

// TestOpenAIQuotaExhaustedNotRetried: khateway's prepaid-balance 429 is
// a verdict, not a rate limit — it must surface on the first response.
func TestOpenAIQuotaExhaustedNotRetried(t *testing.T) {
	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Retry-After", "0")
		w.WriteHeader(http.StatusTooManyRequests)
		w.Write([]byte(`{"error":{"message":"Prepaid balance exhausted","type":"insufficient_quota","code":"insufficient_quota"}}`))
	}))
	defer srv.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_BASE_URL", srv.URL)
	p := NewOpenAI()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "gpt-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	sawErr := false
	for ev := range ch {
		if e, ok := ev.(ErrorEvent); ok {
			sawErr = true
			if !strings.Contains(e.Err.Error(), "insufficient_quota") {
				t.Errorf("error = %v, want the quota body", e.Err)
			}
		}
	}
	if !sawErr {
		t.Error("quota exhaustion did not produce an ErrorEvent")
	}
	if requests != 1 {
		t.Errorf("server saw %d requests, want 1 (quota errors never retry)", requests)
	}
}

// TestStreamStallGuard: a server that opens the SSE stream and then goes
// silent must not hang the turn forever — the watchdog cancels the
// attempt and a "stalled" error surfaces, without a retry.
func TestStreamStallGuard(t *testing.T) {
	old := streamStallLimit
	streamStallLimit = 200 * time.Millisecond
	t.Cleanup(func() { streamStallLimit = old })

	requests := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("Content-Type", "text/event-stream")
		if f, ok := w.(http.Flusher); ok {
			f.Flush()
		}
		<-r.Context().Done() // hold the stream open until the client gives up
	}))
	defer srv.Close()

	t.Setenv("OPENAI_API_KEY", "test-key")
	t.Setenv("OPENAI_BASE_URL", srv.URL)
	p := NewOpenAI()
	p.retryBase = time.Millisecond

	ch, err := p.Stream(t.Context(), Request{Model: "gpt-test", MaxTokens: 16,
		Messages: []Message{{Role: RoleUser, Content: "hi"}}})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	start := time.Now()
	sawErr := false
	for ev := range ch {
		if e, ok := ev.(ErrorEvent); ok {
			sawErr = true
			if !strings.Contains(e.Err.Error(), "stalled") {
				t.Errorf("error = %v, want the stall message", e.Err)
			}
		}
	}
	if !sawErr {
		t.Error("silent stream did not produce an ErrorEvent")
	}
	if elapsed := time.Since(start); elapsed > 10*time.Second {
		t.Errorf("stall surfaced after %s, want promptly", elapsed)
	}
	if requests != 1 {
		t.Errorf("server saw %d requests, want 1 (a stall is not retryable)", requests)
	}
}

// TestQuotaExhaustedDetection pins the body sniff: the gateway's prepaid
// wording is a permanent 429; a plain rate limit stays retryable.
func TestQuotaExhaustedDetection(t *testing.T) {
	if !quotaExhausted(errors.New(`429 {"type":"insufficient_quota","code":"insufficient_quota"}`)) {
		t.Error("insufficient_quota not detected")
	}
	if quotaExhausted(errors.New(`429 {"type":"rate_limit_error","message":"slow down"}`)) {
		t.Error("plain rate limit misdetected as quota exhaustion")
	}
}
