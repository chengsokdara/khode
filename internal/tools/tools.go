// Package tools implements khode's project tools and the registry the
// agent loop consults. Read-only tools run freely; mutating ones are
// gated by the permission system in the agent loop.
package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"path/filepath"
	"sort"
	"strings"

	"khode/internal/llm"
	"khode/internal/perm"
)

// Tool is one capability the model can invoke. Exec returns the output
// shown to the model; an error becomes an error-result for that call.
type Tool interface {
	Name() string
	Description() string
	// Schema is the JSON-schema object describing the Exec input.
	Schema() json.RawMessage
	Exec(ctx context.Context, args json.RawMessage) (string, error)
}

// Previewer is implemented by tools that can describe what they would
// change without changing it, for approval dialogs.
type Previewer interface {
	// Preview renders a human-readable summary of the change the given
	// arguments would make, without applying it.
	Preview(args json.RawMessage) (string, error)
}

// RiskClassifier is implemented by tools that need more than read
// permission; tools without it are treated as read-only.
type RiskClassifier interface {
	Risk() perm.Risk
}

// Registry holds the tools available to the agent, keyed by name.
type Registry struct {
	byName map[string]Tool
}

// NewRegistry returns an empty registry.
func NewRegistry() *Registry {
	return &Registry{byName: map[string]Tool{}}
}

// Register adds a tool, replacing any previous tool of the same name.
func (r *Registry) Register(t Tool) {
	if r.byName == nil {
		r.byName = map[string]Tool{}
	}
	r.byName[t.Name()] = t
}

// Get looks a tool up by name.
func (r *Registry) Get(name string) (Tool, bool) {
	t, ok := r.byName[name]
	return t, ok
}

// RiskOf reports a tool's risk class; unregistered or unclassified
// tools are read-only.
func (r *Registry) RiskOf(name string) perm.Risk {
	t, ok := r.byName[name]
	if !ok {
		return perm.RiskRead
	}
	if rc, ok := t.(RiskClassifier); ok {
		return rc.Risk()
	}
	return perm.RiskRead
}

// Definitions returns every registered tool as a provider-agnostic
// ToolDef, in name order so prompts and caches stay stable.
func (r *Registry) Definitions() []llm.ToolDef {
	names := r.Names()
	defs := make([]llm.ToolDef, 0, len(names))
	for _, n := range names {
		t := r.byName[n]
		defs = append(defs, llm.ToolDef{
			Name:        t.Name(),
			Description: t.Description(),
			Parameters:  t.Schema(),
		})
	}
	return defs
}

// Names lists registered tool names in order.
func (r *Registry) Names() []string {
	names := make([]string, 0, len(r.byName))
	for n := range r.byName {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// Default builds the phase-4 toolset, rooted at dir: relative paths
// given by the model resolve against it.
func Default(dir string) *Registry {
	r := NewRegistry()
	r.Register(&Read{Root: dir})
	r.Register(&Glob{Root: dir})
	r.Register(&Grep{Root: dir})
	r.Register(&Edit{Root: dir})
	r.Register(&Write{Root: dir})
	r.Register(&Bash{Root: dir})
	return r
}

// resolve makes a model-supplied path absolute: relative paths are
// interpreted against the tool root, absolute paths pass through.
func resolve(root, p string) string {
	if p == "" {
		return root
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p)
	}
	return filepath.Join(root, p)
}

// display renders a path for tool output: relative to the root when it
// lives under it, absolute otherwise.
func display(root, p string) string {
	rel, err := filepath.Rel(root, p)
	if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return filepath.ToSlash(rel)
	}
	return p
}

// arg decodes tool arguments into a typed struct, converting absent
// fields into zero values and surfacing type errors to the model.
func arg(args json.RawMessage, v any) error {
	if len(args) == 0 {
		return nil
	}
	if err := json.Unmarshal(args, v); err != nil {
		return fmt.Errorf("invalid arguments: %w", err)
	}
	return nil
}
