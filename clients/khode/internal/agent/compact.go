package agent

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"khode/internal/llm"
)

// Compaction keeps long sessions inside the model's context window: once
// usage nears the window, every turn before a cut point is replaced by an
// LLM-written summary merged into the first kept user turn. The cut
// always lands on a clean user boundary, so no tool call is ever stranded
// without its result.

const (
	// compactTriggerFrac compacts once the conversation reaches this
	// fraction of the model's context window.
	compactTriggerFrac = 0.8
	// compactKeepFrac caps the kept tail (measured against the window)
	// after compaction, leaving headroom for the next rounds.
	compactKeepFrac = 0.3
	// approxCharsPerToken converts character counts to a rough token
	// estimate before the provider reports exact usage.
	approxCharsPerToken = 4
)

// summarizeSystem drives the summarization request. It is sent as the
// system prompt so the summarized transcript keeps its original shape
// (no extra user turn to break role alternation).
const summarizeSystem = `You summarize a coding-assistant conversation so work can continue in a
fresh context. Write a dense brief the assistant can act on directly:
the user's goal and constraints; what was already done (files changed,
with paths); key decisions and why; the current state, including anything
half-finished; and the exact next steps. Quote critical commands, paths,
identifiers, and small code snippets verbatim. Use plain prose and short
lists, with no preamble — reply with the summary only.`

// estimateTokens approximates the request size of system + msgs in
// tokens. It only picks compaction points; exact usage from the provider
// takes over as soon as a round reports it.
func estimateTokens(system string, msgs []llm.Message) int {
	n := (len(system) + 64) / approxCharsPerToken
	for _, m := range msgs {
		n += (len(m.Content) + 32) / approxCharsPerToken
		for _, c := range m.ToolCalls {
			n += (len(c.ID) + len(c.Name) + len(c.Input) + 64) / approxCharsPerToken
		}
		if m.ToolResult != nil {
			n += (len(m.ToolResult.Content) + len(m.ToolResult.CallID) + 64) / approxCharsPerToken
		}
	}
	return n
}

// cutIndex picks the boundary that starts the kept tail: the newest user
// turn (never a tool result) whose tail stays within keepTokens. It
// returns 0 when there is nothing worth compacting — index 0 would mean
// summarizing nothing.
func cutIndex(msgs []llm.Message, keepTokens int) int {
	acc := 0
	cut := 0
	for i := len(msgs) - 1; i >= 0; i-- {
		acc += estimateTokens("", msgs[i:i+1])
		if acc > keepTokens {
			break
		}
		if msgs[i].Role == llm.RoleUser && msgs[i].ToolResult == nil && i > 0 {
			cut = i
		}
	}
	return cut
}

// maybeCompact compacts before a round when the conversation nears the
// model's context window. Compaction failures are deliberately
// non-fatal: the turn continues on the uncompressed history, and the
// next provider call reports a real error if it truly cannot fit.
func (r *Runner) maybeCompact(ctx context.Context, out chan<- llm.Event) {
	window := llm.ContextWindow(r.Model)
	tokens := r.lastInput
	if est := estimateTokens(r.System, r.Session.Messages()); est > tokens {
		tokens = est
	}
	if float64(tokens) < compactTriggerFrac*float64(window) {
		return
	}
	removed, err := r.compact(ctx)
	if err != nil || removed == 0 {
		return
	}
	out <- llm.CompactEvent{Removed: removed, Kept: len(r.Session.Messages())}
}

// compact summarizes every turn before the cut point and rewrites the
// session with summary + kept tail. It returns the number of summarized
// messages.
func (r *Runner) compact(ctx context.Context) (int, error) {
	msgs := r.Session.Messages()
	keepTokens := int(compactKeepFrac * float64(llm.ContextWindow(r.Model)))
	cut := cutIndex(msgs, keepTokens)
	if cut <= 0 {
		return 0, nil
	}

	summary, err := r.summarize(ctx, msgs[:cut])
	if err != nil {
		return 0, fmt.Errorf("summarizing: %w", err)
	}

	// The summary rides inside the first kept user turn so the rewritten
	// history never has two consecutive user messages.
	kept := make([]llm.Message, 0, len(msgs)-cut)
	head := msgs[cut]
	head.Content = fmt.Sprintf(
		"## Summary of earlier conversation\n\n%s\n\nThe summary above replaces the earlier turns; continue from there.\n\n%s",
		summary, head.Content)
	kept = append(kept, head)
	kept = append(kept, msgs[cut+1:]...)

	if err := r.Session.Replace(kept); err != nil {
		return 0, fmt.Errorf("rewriting session: %w", err)
	}
	r.lastInput = estimateTokens(r.System, kept)
	return cut, nil
}

// summarize asks the model for a compact brief of msgs. No tools are
// advertised, so the reply is prose by construction.
func (r *Runner) summarize(ctx context.Context, msgs []llm.Message) (string, error) {
	ch, err := r.Provider.Stream(ctx, r.request(summarizeSystem, msgs, nil))
	if err != nil {
		return "", err
	}
	var b strings.Builder
	terminal := false
	for ev := range ch {
		switch e := ev.(type) {
		case llm.TextDeltaEvent:
			b.WriteString(e.Text)
		case llm.ErrorEvent:
			return "", e.Err
		case llm.DoneEvent:
			terminal = true
		}
	}
	if !terminal {
		return "", errors.New("summary stream closed without a terminal event")
	}
	summary := strings.TrimSpace(b.String())
	if summary == "" {
		return "", errors.New("model produced an empty summary")
	}
	return summary, nil
}

// Compact forces compaction regardless of thresholds and returns how
// many messages were summarized (0 when there is nothing to compact) —
// the /compact command's entry point.
func (r *Runner) Compact(ctx context.Context) (int, error) {
	return r.compact(ctx)
}
