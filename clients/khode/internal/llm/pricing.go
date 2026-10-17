package llm

import (
	"sort"
	"strings"
)

// Price is a model's list price in USD per million tokens.
type Price struct {
	Input  float64
	Output float64
}

// priceTable maps model-name prefixes to list prices (USD per million
// tokens, standard tier, checked 2026-09). Longest prefix wins, so dated
// snapshots ("gpt-5-mini-2025-08-07") resolve to their family's entry.
// Models missing from the table simply get no cost estimate.
var priceTable = map[string]Price{
	// Anthropic
	"claude-opus":   {Input: 15.00, Output: 75.00},
	"claude-sonnet": {Input: 3.00, Output: 15.00},
	"claude-haiku":  {Input: 1.00, Output: 5.00},
	// OpenAI
	"gpt-5.6-terra": {Input: 2.00, Output: 12.00},
	"gpt-5.6-luna":  {Input: 0.20, Output: 1.20},
	"gpt-5-mini":    {Input: 0.25, Output: 2.00},
	"gpt-5-nano":    {Input: 0.05, Output: 0.40},
	"gpt-5":         {Input: 1.25, Output: 10.00},
	"o4-mini":       {Input: 1.10, Output: 4.40},
	"o3-mini":       {Input: 1.10, Output: 4.40},
	"o3":            {Input: 2.00, Output: 8.00},
}

// priceKeys holds priceTable keys longest-first so prefix matching picks
// the most specific family.
var priceKeys = func() []string {
	keys := make([]string, 0, len(priceTable))
	for k := range priceTable {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	return keys
}()

// ModelPrice looks up the list price for a model name (family prefixes
// also match dated snapshots). ok is false for unknown models.
func ModelPrice(model string) (Price, bool) {
	m := strings.ToLower(model)
	for _, k := range priceKeys {
		if strings.HasPrefix(m, k) {
			return priceTable[k], true
		}
	}
	return Price{}, false
}

// CostEstimate sums the USD cost of a response given its model and token
// counts; ok is false when the model has no known price.
func CostEstimate(model string, inTokens, outTokens int64) (float64, bool) {
	p, ok := ModelPrice(model)
	if !ok {
		return 0, false
	}
	return float64(inTokens)/1e6*p.Input + float64(outTokens)/1e6*p.Output, true
}
