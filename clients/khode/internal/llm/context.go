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

// glm53Model reports whether model is a GLM-5.3 family id or a gateway
// slug of one. Slugs collapse the upstream slash ("z-ai/glm-5.3" becomes
// "z-ai-glm-5.3"), so this is a contains check, not a prefix. It also
// covers glm-5.3-flash.
func glm53Model(model string) bool {
	return strings.Contains(strings.ToLower(model), "glm-5.3")
}

// ContextWindow returns the model's total context window in tokens,
// matching by family prefix. GLM-5.3 is matched by contains first so a
// gateway slug still resolves to the real 1,048,576-token window.
func ContextWindow(model string) int {
	if glm53Model(model) {
		return 1_048_576
	}
	m := strings.ToLower(model)
	for _, k := range contextKeys {
		if strings.HasPrefix(m, k) {
			return contextWindows[k]
		}
	}
	return defaultContextWindow
}
