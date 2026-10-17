package llm

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Retry policy shared by the provider implementations: transient failures
// (rate limits, provider overload, 5xx, dropped connections) are retried
// with exponential backoff — but only while the stream has produced no
// content and the wall clock is still inside the retry budget. A retry
// after visible output would duplicate it; a retry after a slow failure
// (a gateway answering 504 after its own minute-long upstream timeout)
// would stack into minutes of silent "working", so the budget surfaces
// the error instead. Each provider classifies its own SDK error types
// via retryableStatus / retryableNet and reports a Retry-After header
// when the response carried one.

const (
	// DefaultMaxRetries is how many times a failed attempt may be
	// repeated after the initial try.
	DefaultMaxRetries = 4
	// baseRetryDelay seeds the exponential backoff (500ms, 1s, 2s, …).
	baseRetryDelay = 500 * time.Millisecond
	// maxRetryDelay caps every wait, including Retry-After values.
	maxRetryDelay = 8 * time.Second
	// DefaultRetryBudget is the wall-clock a Stream call may spend on
	// failed attempts before the next error surfaces instead of being
	// retried. Attempt time counts, so a gateway that takes a minute to
	// answer 504 spends the budget on the first try and never retries —
	// exactly the stack-up that pinned turns in "working" for minutes.
	DefaultRetryBudget = 45 * time.Second
)

// streamStallLimit is how long a streaming attempt may go without any
// SSE progress before the stall guard cancels it and surfaces an error:
// the bound that keeps a silently dead upstream from hanging a turn
// forever (the SDKs' synchronous Next() would otherwise wait forever).
// Generous on purpose — gateways with their own upstream timeout should
// get to deliver their informative 504 first. Var so tests shrink it.
var streamStallLimit = 90 * time.Second

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

// quotaExhausted reports whether err is a rate limit that will never
// succeed on retry — the gateway's prepaid balance is gone (khateway /
// openai's "insufficient_quota" body). Unlike a plain rate limit, waiting
// cannot help, so the error must surface at once.
func quotaExhausted(err error) bool {
	return strings.Contains(err.Error(), "insufficient_quota")
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

// stallGuard cancels a streaming attempt's context when the stream goes
// streamStallLimit without progress, unblocking the SDK's synchronous
// Next() loop — the bound that keeps a silently dead upstream from
// pinning a turn in "working" forever.
type stallGuard struct {
	cancel context.CancelFunc
	limit  time.Duration
	last   atomic.Int64 // unix nanos of the last progress report
	stopCh chan struct{}
	once   sync.Once
}

// newStallGuard starts watching; progress() must be called after every
// stream event. stop (idempotent, deferred by the attempt) ends it.
func newStallGuard(cancel context.CancelFunc, limit time.Duration) *stallGuard {
	g := &stallGuard{cancel: cancel, limit: limit, stopCh: make(chan struct{})}
	g.last.Store(time.Now().UnixNano())
	tick := limit / 4
	if tick > time.Second {
		tick = time.Second
	}
	if tick < 10*time.Millisecond {
		tick = 10 * time.Millisecond
	}
	go func() {
		t := time.NewTicker(tick)
		defer t.Stop()
		for {
			select {
			case <-g.stopCh:
				return
			case <-t.C:
				if time.Since(time.Unix(0, g.last.Load())) >= g.limit {
					g.cancel()
					return
				}
			}
		}
	}()
	return g
}

// progress records stream activity, resetting the stall clock.
func (g *stallGuard) progress() { g.last.Store(time.Now().UnixNano()) }

// stop halts the watcher.
func (g *stallGuard) stop() { g.once.Do(func() { close(g.stopCh) }) }

// stalledErr is the error surfaced when the guard fires: attemptCtx is
// canceled but the caller's context (the turn) is still alive.
func stalledErr() error {
	return fmt.Errorf("model stream stalled: no data for %s", streamStallLimit)
}
