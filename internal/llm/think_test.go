package llm

import "testing"

func TestThinkSplitter(t *testing.T) {
	tests := []struct {
		name     string
		deltas   []string
		answer   string
		thinking string
	}{
		{"plain answer", []string{"hello ", "world"}, "hello world", ""},
		{"whole tag in one delta", []string{"<think>why</think>so"}, "so", "why"},
		{"open tag split", []string{"<thi", "nk>abc</think>xyz"}, "xyz", "abc"},
		{"close tag split", []string{"<think>ab", "c</th", "ink>tail"}, "tail", "abc"},
		{"tag split mid-angle", []string{"abc<", "think>d</think>e"}, "abce", "d"},
		{"multiple blocks", []string{"a<think>x</think>b<think>y</think>c"}, "abc", "xy"},
		{"lt sign is not a tag", []string{"a < b and c"}, "a < b and c", ""},
		{"false tag prefix stays text", []string{"i <think about it"}, "i <think about it", ""},
		{"unterminated think stays thinking", []string{"<think>never closed"}, "", "never closed"},
		{"dangling fragment flushed as text", []string{"done<thi"}, "done<thi", ""},
		{"dangling fragment flushed as thinking", []string{"<think>work</thi"}, "", "work</thi"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var sp thinkSplitter
			var answer, thinking string
			for _, d := range tt.deltas {
				a, th := sp.Feed(d)
				answer += a
				thinking += th
			}
			a, th := sp.Flush()
			answer += a
			thinking += th
			if answer != tt.answer {
				t.Errorf("answer = %q, want %q", answer, tt.answer)
			}
			if thinking != tt.thinking {
				t.Errorf("thinking = %q, want %q", thinking, tt.thinking)
			}
		})
	}
}

func TestStripThinkTags(t *testing.T) {
	tests := []struct{ in, want string }{
		{"no tags here", "no tags here"},
		{"<think>r</think>answer", "answer"},
		{"a<think>1</think>b<think>2</think>c", "abc"},
		{"<think>unclosed tail only", ""},
		{"plain", "plain"},
	}
	for _, tt := range tests {
		if got := StripThinkTags(tt.in); got != tt.want {
			t.Errorf("StripThinkTags(%q) = %q, want %q", tt.in, got, tt.want)
		}
	}
}
