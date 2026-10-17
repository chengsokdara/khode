package llm

import "strings"

// OpenAI-protocol reasoning models (DeepSeek, Ollama, several proxies)
// deliver their reasoning either in a `reasoning_content` delta field or
// inline in the content wrapped in <think></think> tags. Both have to be
// split out of the answer text before it reaches the transcript and the
// UI, or the tags render as literal content.

const (
	thinkOpen  = "<think>"
	thinkClose = "</think>"
)

// thinkSplitter classifies a stream of content deltas as answer text or
// thinking, recognizing the tags even when they arrive split across
// deltas: a trailing fragment that could still complete into a tag is
// held back until the next Feed settles it.
type thinkSplitter struct {
	inThink bool
	pending string
}

// Feed classifies the next content delta and returns the answer-text and
// thinking pieces it contains (either may be empty).
func (sp *thinkSplitter) Feed(text string) (answer, thinking string) {
	s := sp.pending + text
	sp.pending = ""

	var ans, think strings.Builder
	for s != "" {
		tag := thinkClose
		if !sp.inThink {
			tag = thinkOpen
		}
		i := strings.Index(s, tag)
		if i < 0 {
			// A trailing "<…" fragment may still complete into the tag
			// once more deltas arrive; hold it back and emit the rest.
			keep := sp.holdTagPrefix(s, tag)
			if sp.inThink {
				think.WriteString(s[:keep])
			} else {
				ans.WriteString(s[:keep])
			}
			break
		}
		if sp.inThink {
			think.WriteString(s[:i])
		} else {
			ans.WriteString(s[:i])
		}
		s = s[i+len(tag):]
		sp.inThink = !sp.inThink
	}
	return ans.String(), think.String()
}

// Flush classifies whatever is still parked when the stream ends: a
// fragment that never completed a tag is literal text of the state it
// was seen in (an unterminated <think> block stays thinking).
func (sp *thinkSplitter) Flush() (answer, thinking string) {
	p := sp.pending
	sp.pending = ""
	if sp.inThink {
		return "", p
	}
	return p, ""
}

// holdTagPrefix parks a trailing "<…" fragment of s that could still
// complete into tag and returns how much of s may be emitted now.
func (sp *thinkSplitter) holdTagPrefix(s, tag string) int {
	i := strings.LastIndex(s, "<")
	if i < 0 || !strings.HasPrefix(tag, s[i:]) {
		return len(s) // no tag can start at any "<" in s
	}
	sp.pending = s[i:]
	return i
}

// StripThinkTags removes <think>...</think> blocks from a complete
// message body, so assistant history written before thinking was split
// out never replays its reasoning to the provider as answer content.
func StripThinkTags(s string) string {
	for {
		open := strings.Index(s, thinkOpen)
		if open < 0 {
			return s
		}
		close := strings.Index(s[open:], thinkClose)
		if close < 0 {
			return s[:open] // unterminated: the tail is all thinking
		}
		s = s[:open] + s[open+close+len(thinkClose):]
	}
}
