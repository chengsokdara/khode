package llm

import (
	"math"
	"testing"
)

func TestModelPrice(t *testing.T) {
	tests := []struct {
		model string
		want  Price
	}{
		// Exact table entries.
		{"gpt-5-mini", Price{0.25, 2.00}},
		{"gpt-5.6-terra", Price{2.00, 12.00}},
		{"claude-sonnet-4-5", Price{3.00, 15.00}},
		// Dated snapshots resolve to their family.
		{"gpt-5-mini-2025-08-07", Price{0.25, 2.00}},
		{"claude-sonnet-4-5-20250929", Price{3.00, 15.00}},
		// Longest prefix wins over shorter families.
		{"gpt-5.6-luna", Price{0.20, 1.20}}, // not gpt-5's price
		{"o3-mini", Price{1.10, 4.40}},      // not o3's price
		// Case-insensitive.
		{"GPT-5-Mini", Price{0.25, 2.00}},
	}
	for _, tt := range tests {
		got, ok := ModelPrice(tt.model)
		if !ok {
			t.Errorf("ModelPrice(%q) not found", tt.model)
			continue
		}
		if got != tt.want {
			t.Errorf("ModelPrice(%q) = %v, want %v", tt.model, got, tt.want)
		}
	}

	if _, ok := ModelPrice("mystery-model"); ok {
		t.Error("unknown model returned a price")
	}
}

func TestCostEstimate(t *testing.T) {
	// 1M in + 2M out at gpt-5-mini ($0.25 / $2.00 per Mtok) = $4.25.
	got, ok := CostEstimate("gpt-5-mini", 1_000_000, 2_000_000)
	if !ok {
		t.Fatal("gpt-5-mini has no price")
	}
	if math.Abs(got-4.25) > 1e-9 {
		t.Errorf("cost = %v, want 4.25", got)
	}

	// A typical small response stays sub-cent: 900 in / 300 out at
	// claude-sonnet-4-5 ($3 / $15) = $0.0072.
	got, ok = CostEstimate("claude-sonnet-4-5", 900, 300)
	if !ok {
		t.Fatal("claude-sonnet-4-5 has no price")
	}
	if math.Abs(got-0.0072) > 1e-9 {
		t.Errorf("cost = %v, want 0.0072", got)
	}

	if _, ok := CostEstimate("mystery-model", 10, 10); ok {
		t.Error("unknown model returned a cost")
	}
}
