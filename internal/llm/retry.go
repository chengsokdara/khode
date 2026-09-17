package llm

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"
)

// Retry policy shared by the provider implementations: transient failures
// (rate limits, provider overload, 5xx, dropped connections) are retried
// with exponential backoff — but only while the stream has produced no
// content. A retry after visible output would duplicate it, so those
// errors surface to the caller as usual. Each provider classifies its own
// SDK error types via retryableStatus / retryableNet and reports a
// Retry-After header when the response carried one.

const (
	// DefaultMaxRetries is how many times a failed attempt may be
	// repeated after the initial try.
	DefaultMaxRetries = 4
	// baseRetryDelay seeds the exponential backoff (500ms, 1s, 2s, …).
	baseRetryDelay = 500 * time.Millisecond
	// maxRetryDelay caps every wait, including Retry-After values.
	maxRetryDelay = 8 * time.Second
)

// retryableStatus reports whether an HTTP status suggests a repeated
// request may succeed. 529 is Anthropic's "overloaded".
func retryableStatus(code int) bool {
	switch code {
	case http.StatusRequestTimeout, http.StatusConflict,
		http.StatusTooManyRequests, http.StatusInternalServerError,
		http.StatusBadGateway, http.StatusServiceUnavailable,
		http.StatusGatewayTimeout, 529:
		return true
	}
	return false
}

// retryableNet reports whether err is a transport-level failure worth
// retrying: timeouts, refused or reset connections, truncated bodies.
// Connection resets arrive wrapped in net.OpError, which satisfies
// net.Error.
func retryableNet(err error) bool {
	if errors.Is(err, io.ErrUnexpectedEOF) {
		return true
	}
	var ne net.Error
	return errors.As(err, &ne)
}

// retryDelay picks the wait before the next attempt after n failures
// (0-based): a numeric Retry-After header when present, else exponential
// backoff from base (baseRetryDelay when base is 0) — all capped at
// maxRetryDelay.
func retryDelay(n int, retryAfter string, base time.Duration) time.Duration {
	if secs, err := strconv.Atoi(strings.TrimSpace(retryAfter)); err == nil && secs >= 0 {
		return min(maxRetryDelay, time.Duration(secs)*time.Second)
	}
	if base <= 0 {
		base = baseRetryDelay
	}
	d := base << n
	if d <= 0 || d > maxRetryDelay {
		return maxRetryDelay
	}
	return d
}

// backoffSleep waits d, aborting early on ctx cancellation. It returns
// false when the wait was interrupted.
func backoffSleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
