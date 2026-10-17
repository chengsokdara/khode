package llm

import "testing"

func TestContextWindow(t *testing.T) {
	cases := map[string]int{
		"claude-sonnet-4-5":  200_000,
		"claude-opus-4-1":    200_000,
		"gpt-5-mini":         400_000,
		"gpt-5.6-terra":      400_000,
		"gpt-4.1-2025-04-14": 1_000_000,
		"gpt-4o":             128_000,
		"o3-mini":            200_000,
		"o4-mini-2025":       200_000,
		"unknown-model":      defaultContextWindow,
		"glm-5.3":            1_048_576,
		"glm-5.3-flash":      1_048_576,
		"z-ai-glm-5.3":       1_048_576,
		"Z-AI/GLM-5.3-Flash": 1_048_576,
	}
	for model, want := range cases {
		if got := ContextWindow(model); got != want {
			t.Errorf("ContextWindow(%q) = %d, want %d", model, got, want)
		}
	}
}
