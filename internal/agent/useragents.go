package agent

// User-defined subagent kinds: one markdown file per kind in
// ~/.khode/agents/. Frontmatter carries the fields (name, description,
// an optional tool allowlist, an optional model pin) and the body is the
// kind's system-prompt section. Loaded kinds join the built-in catalog,
// so the task tool's subagent_type accepts them and /agents lists them.
// A file that fails to parse warns but never keeps khode from starting.

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"khode/internal/tools"
)

// userKindMu guards the catalog: LoadUserAgents (startup, and /agents's
// reload key) replaces it while a task spawn may be reading it on the
// agent goroutine.
var (
	userKindMu   sync.RWMutex
	userKinds    map[SubagentKind]kindSpec
	userKindWarn []string
)

// agentFileFields are the frontmatter keys a user agent file may carry;
// anything else warns, so a typo (`tool:` instead of `tools:`) surfaces
// instead of silently producing a full-toolset agent.
var agentFileFields = map[string]bool{
	"name": true, "description": true, "tools": true, "model": true,
}

// LoadUserAgents replaces the user-defined kind catalog from dir: one
// *.md file per kind, read in filename order (first file wins a name
// clash). It returns one warning string per problem file — a missing
// directory is not a problem. Built-in names are refused; renaming the
// file is the fix, so a user file can never silently shadow a profile.
func LoadUserAgents(dir string) []string {
	var warns []string
	kinds := map[SubagentKind]kindSpec{}

	entries, err := os.ReadDir(dir)
	if err != nil {
		if !errors.Is(err, fs.ErrNotExist) {
			warns = append(warns, fmt.Sprintf("reading %s: %v", dir, err))
		}
	} else {
		for _, e := range entries {
			if e.IsDir() || !strings.EqualFold(filepath.Ext(e.Name()), ".md") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(dir, e.Name()))
			if err != nil {
				warns = append(warns, fmt.Sprintf("agents: reading %s: %v", e.Name(), err))
				continue
			}
			kind, spec, fw := parseUserAgent(e.Name(), string(data))
			warns = append(warns, fw...)
			if kind == "" {
				continue
			}
			if _, clash := subagentKinds[kind]; clash {
				warns = append(warns, fmt.Sprintf("agents: %s: name %q is built-in — rename the file or its name field", e.Name(), kind))
				continue
			}
			if _, dup := kinds[kind]; dup {
				warns = append(warns, fmt.Sprintf("agents: %s: duplicate name %q — first file wins", e.Name(), kind))
				continue
			}
			kinds[kind] = spec
		}
	}

	userKindMu.Lock()
	userKinds = kinds
	userKindWarn = warns
	userKindMu.Unlock()
	return warns
}

// UserAgentWarnings returns the warnings from the last LoadUserAgents
// run, for surfaces like /agents to display.
func UserAgentWarnings() []string {
	userKindMu.RLock()
	defer userKindMu.RUnlock()
	return userKindWarn
}

// parseUserAgent turns one agents/*.md file into a kind. The kind name
// is empty when the file must be skipped. The file may carry a `---`
// frontmatter block; without one the whole content is the instructions.
func parseUserAgent(file, content string) (SubagentKind, kindSpec, []string) {
	var warns []string
	fields, body, fw := splitFrontmatter(file, content)
	warns = append(warns, fw...)

	name := fields["name"]
	if name == "" {
		name = strings.TrimSuffix(file, filepath.Ext(file))
	}
	name = strings.ToLower(strings.Join(strings.Fields(name), "-"))
	if name == "" {
		warns = append(warns, fmt.Sprintf("agents: %s: empty name — skipped", file))
		return "", kindSpec{}, warns
	}

	desc := strings.Join(strings.Fields(fields["description"]), " ")
	return SubagentKind(name), kindSpec{
		Label:       name,
		Description: desc,
		Tools:       splitToolList(fields["tools"]),
		Model:       strings.TrimSpace(fields["model"]),
		// User kinds keep the general-purpose report budget; the
		// allowlist, not a flag, is what restrains the toolset.
		ReportCap: maxTaskResult,
		Section:   strings.TrimSpace(body),
	}, warns
}

// splitFrontmatter parses a leading `---` block into key: value fields.
// Unterminated or malformed blocks degrade to body-only (with a
// warning), never a load failure.
func splitFrontmatter(file, content string) (map[string]string, string, []string) {
	var warns []string
	content = strings.TrimPrefix(content, "\uFEFF")
	lines := strings.Split(content, "\n")
	if strings.TrimSpace(lines[0]) != "---" {
		return nil, content, nil
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			end = i
			break
		}
	}
	if end < 0 {
		warns = append(warns, fmt.Sprintf("agents: %s: unterminated --- block — treating the whole file as instructions", file))
		return nil, content, warns
	}

	fields := map[string]string{}
	for _, ln := range lines[1:end] {
		ln = strings.TrimSpace(strings.TrimRight(ln, "\r"))
		if ln == "" {
			continue
		}
		key, value, ok := strings.Cut(ln, ":")
		if !ok {
			warns = append(warns, fmt.Sprintf("agents: %s: frontmatter line %q is not key: value — ignored", file, ln))
			continue
		}
		key = strings.ToLower(strings.TrimSpace(key))
		if !agentFileFields[key] {
			warns = append(warns, fmt.Sprintf("agents: %s: unknown frontmatter field %q — ignored", file, key))
			continue
		}
		fields[key] = strings.TrimSpace(value)
	}
	return fields, strings.Join(lines[end+1:], "\n"), warns
}

// splitToolList splits a comma- and/or space-separated tool allowlist,
// lowercased and deduplicated in order.
func splitToolList(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, part := range strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t'
	}) {
		name := strings.ToLower(strings.TrimSpace(part))
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, name)
	}
	return out
}

// lookupKind finds a kind in either catalog, built-ins first.
func lookupKind(k SubagentKind) (kindSpec, bool) {
	if spec, ok := subagentKinds[k]; ok {
		return spec, true
	}
	userKindMu.RLock()
	defer userKindMu.RUnlock()
	spec, ok := userKinds[k]
	return spec, ok
}

// KindInfo is one catalog entry for display surfaces (/agents) and the
// task schema.
type KindInfo struct {
	Name        string   // the subagent_type value
	Label       string   // short label for progress lines
	Description string   // one-line summary
	Tools       []string // effective toolset names
	ReadOnly    bool     // every tool in the set is read-only
	Builtin     bool     // false for loaded ~/.khode/agents kinds
}

// KindNames lists every kind name, built-ins and user agents, in name
// order — the order the task schema enumerates.
func KindNames() []string {
	userKindMu.RLock()
	defer userKindMu.RUnlock()
	names := make([]string, 0, len(subagentKinds)+len(userKinds))
	for k := range subagentKinds {
		names = append(names, string(k))
	}
	for k := range userKinds {
		names = append(names, string(k))
	}
	sort.Strings(names)
	return names
}

// KindInfos snapshots the whole catalog in name order. Tools is the
// effective toolset the kind spawns with.
func KindInfos() []KindInfo {
	userKindMu.RLock()
	defer userKindMu.RUnlock()
	infos := make([]KindInfo, 0, len(subagentKinds)+len(userKinds))
	add := func(k SubagentKind, s kindSpec, builtin bool) {
		infos = append(infos, KindInfo{
			Name:        string(k),
			Label:       s.Label,
			Description: s.Description,
			Tools:       effectiveTools(s),
			ReadOnly:    kindIsReadOnly(s),
			Builtin:     builtin,
		})
	}
	for k, s := range subagentKinds {
		add(k, s, true)
	}
	for k, s := range userKinds {
		add(k, s, false)
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].Name < infos[j].Name })
	return infos
}

// defaultToolNames is tools.Default's set, for display; pinned against
// the real registry by TestDefaultToolNames.
var defaultToolNames = []string{"bash", "edit", "glob", "grep", "read", "todo", "write"}

// effectiveTools names the toolset a kind actually spawns with.
func effectiveTools(s kindSpec) []string {
	switch {
	case s.ReadOnly:
		return []string{"glob", "grep", "read"}
	case len(s.Tools) > 0:
		return append([]string(nil), s.Tools...)
	default:
		return append([]string(nil), defaultToolNames...)
	}
}

// userTool instantiates an allowlisted tool for a user-defined kind:
// built-ins get fresh instances rooted at the subagent's workdir (so
// the main registry's session toggles never leak into subagents), and
// any other name — MCP tools — is borrowed from the source registry.
// task and plan never resolve: subagents do not recurse and never open
// main-loop dialogs. Names that resolve to nothing are dropped.
func userTool(name, workdir string, src *tools.Registry) tools.Tool {
	switch name {
	case "read":
		return &tools.Read{Root: workdir}
	case "glob":
		return &tools.Glob{Root: workdir}
	case "grep":
		return &tools.Grep{Root: workdir}
	case "edit":
		return &tools.Edit{Root: workdir}
	case "write":
		return &tools.Write{Root: workdir}
	case "bash":
		return &tools.Bash{Root: workdir}
	case "todo":
		return tools.NewTodos()
	case "task", "plan":
		return nil
	}
	if src == nil {
		return nil
	}
	t, ok := src.Get(name)
	if !ok {
		return nil
	}
	return t
}
