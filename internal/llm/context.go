package llm

import (
	"sort"
	"strings"
)

// contextWindows maps model-name prefixes to the total context window
// (input + output, tokens). Longest prefix wins, so dated snapshots
// resolve to their family. Models missing from the table get the
// conservative fallback.
var contextWindows = map[string]int{
	"claude":  200_000,
	"gpt-4.1": 1_000_000,
	"gpt-4":   128_000,
	"gpt-5":   400_000,
	"o1":      200_000,
	"o3":      200_000,
	"o4":      200_000,
}

// defaultContextWindow is used for models with no table entry — small
// enough to be safe, large enough to be useful.
const defaultContextWindow = 128_000

// contextKeys holds contextWindows keys longest-first so prefix matching
// picks the most specific family.
var contextKeys = func() []string {
	keys := make([]string, 0, len(contextWindows))
	for k := range contextWindows {
		keys = append(keys, k)
	}
	sort.Slice(keys, func(i, j int) bool { return len(keys[i]) > len(keys[j]) })
	return keys
}()

// ContextWindow returns the model's total context window in tokens,
// matching by family prefix.
func ContextWindow(model string) int {
	m := strings.ToLower(model)
	for _, k := range contextKeys {
		if strings.HasPrefix(m, k) {
			return contextWindows[k]
		}
	}
	return defaultContextWindow
}
