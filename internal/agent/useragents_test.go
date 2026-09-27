package agent

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/perm"
	"khode/internal/tools"
)

// resetUserAgents clears the user-kind catalog after a test that loaded
// files, so other tests see the built-ins only.
func resetUserAgents(t *testing.T) {
	t.Helper()
	t.Cleanup(func() { LoadUserAgents(t.TempDir()) })
}

func TestParseUserAgentFrontmatter(t *testing.T) {
	kind, spec, warns := parseUserAgent("security.md", `---
name: security-audit
description: Audits code for injection and secret-leak risks
tools: read, glob   grep
model: fast-mini
---

# Security audit

Check every handler.`)
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if kind != "security-audit" {
		t.Fatalf("kind = %q", kind)
	}
	if spec.Description != "Audits code for injection and secret-leak risks" {
		t.Errorf("description = %q", spec.Description)
	}
	// Comma- and space-separated names both parse.
	if got, want := strings.Join(spec.Tools, ","), "read,glob,grep"; got != want {
		t.Errorf("tools = %q, want %q", got, want)
	}
	if spec.Model != "fast-mini" {
		t.Errorf("model = %q", spec.Model)
	}
	if spec.ReportCap != maxTaskResult {
		t.Errorf("report cap = %d, want the general budget", spec.ReportCap)
	}
	if !strings.HasPrefix(spec.Section, "# Security audit") || !strings.HasSuffix(spec.Section, "Check every handler.") {
		t.Errorf("section = %q", spec.Section)
	}
}

func TestParseUserAgentDefaults(t *testing.T) {
	// No frontmatter: the whole file is the section and the name comes
	// from the filename; name casing normalizes and inner spaces
	// collapse to dashes.
	kind, spec, warns := parseUserAgent("My Agent.md", "Just the instructions.")
	if len(warns) != 0 {
		t.Fatalf("unexpected warnings: %v", warns)
	}
	if kind != "my-agent" || spec.Label != "my-agent" {
		t.Fatalf("kind = %q", kind)
	}
	if spec.Section != "Just the instructions." || spec.Tools != nil || spec.Model != "" {
		t.Errorf("spec = %+v", spec)
	}
}

func TestParseUserAgentWarns(t *testing.T) {
	// Unknown fields, malformed lines, and unterminated blocks warn but
	// still produce a kind (or none, when the name is unusable).
	_, _, warns := parseUserAgent("a.md", "---\ntool: read\n---\nbody")
	if len(warns) != 1 || !strings.Contains(warns[0], "unknown frontmatter field") {
		t.Errorf("unknown-field warnings = %v", warns)
	}
	_, _, warns = parseUserAgent("b.md", "---\nno colon here\n---\nbody")
	if len(warns) != 1 || !strings.Contains(warns[0], "not key: value") {
		t.Errorf("malformed-line warnings = %v", warns)
	}
	kind, _, warns := parseUserAgent("c.md", "---\nname: never-closed\nbody")
	// An unterminated block degrades to filename-as-name + body-as-section
	// rather than dropping the kind; the warning tells the user why.
	if kind != "c" || len(warns) != 1 || !strings.Contains(warns[0], "unterminated") {
		t.Errorf("unterminated block: kind=%q warnings=%v", kind, warns)
	}
}

func TestLoadUserAgentsJoinsCatalog(t *testing.T) {
	resetUserAgents(t)
	dir := t.TempDir()
	writeAgent := func(name, content string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(dir, name), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	writeAgent("lint-fix.md", "---\nname: lint-fixer\ndescription: fixes lint findings\ntools: read, edit, bash\n---\nFix the lint.")
	writeAgent("skipped.md", "---\nname: explore\ndescription: shadows a built-in\n---\nnope")
	writeAgent("broken.md", "not really markdown but usable\n")

	warns := LoadUserAgents(dir)
	if len(warns) != 1 || !strings.Contains(warns[0], "built-in") {
		t.Fatalf("warnings = %v, want exactly the built-in clash", warns)
	}

	kind, spec := normalizeKind("lint-fixer")
	if kind != "lint-fixer" || spec.Description != "fixes lint findings" {
		t.Fatalf("normalizeKind(lint-fixer) = %q %+v", kind, spec)
	}
	// The clashing file did not shadow the built-in explore profile.
	if k, _ := normalizeKind("explore"); k != SubagentExplore {
		t.Fatalf("explore shadowed: %q", k)
	}
	// Unknown names still fall back to general-purpose.
	if k, _ := normalizeKind("no-such-agent"); k != SubagentGeneral {
		t.Fatalf("unknown kind = %q", k)
	}

	// Loading replaces the catalog: an empty dir clears user kinds.
	if warns := LoadUserAgents(t.TempDir()); len(warns) != 0 {
		t.Fatalf("clear-load warnings = %v", warns)
	}
	if k, _ := normalizeKind("lint-fixer"); k != SubagentGeneral {
		t.Fatal("reload did not drop the previous user kind")
	}
}

func TestRegistryForUserAllowlist(t *testing.T) {
	resetUserAgents(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "fixer.md"),
		[]byte("---\nname: fixer\ntools: read, edit, bash, mcp__db__query, task\n---\nbody"), 0o644); err != nil {
		t.Fatal(err)
	}
	if warns := LoadUserAgents(dir); len(warns) != 0 {
		t.Fatalf("warnings = %v", warns)
	}

	// Without a source registry only built-in constructors resolve; the
	// MCP name and task (no recursion) drop out.
	reg := registryFor("fixer", t.TempDir(), nil)
	if got, want := strings.Join(reg.Names(), ","), "bash,edit,read"; got != want {
		t.Fatalf("registry names = %q, want %q", got, want)
	}

	// With the main registry as source, MCP tools are borrowed.
	src := tools.NewRegistry()
	src.Register(&fakeSrcTool{name: "mcp__db__query"})
	reg = registryFor("fixer", t.TempDir(), src)
	if got, want := strings.Join(reg.Names(), ","), "bash,edit,mcp__db__query,read"; got != want {
		t.Fatalf("registry names with source = %q, want %q", got, want)
	}
	if reg.RiskOf("bash") != perm.RiskExec {
		t.Errorf("bash risk = %s", reg.RiskOf("bash"))
	}

	// The kind info reports the parsed allowlist and its read-only
	// status comes from the tools, not a flag.
	for _, info := range KindInfos() {
		if info.Name != "fixer" {
			continue
		}
		if info.Builtin {
			t.Error("fixer reported as built-in")
		}
		if strings.Join(info.Tools, ",") != "read,edit,bash,mcp__db__query,task" {
			t.Errorf("info tools = %v", info.Tools)
		}
	}
}

func TestKindInfosReadOnlyBadges(t *testing.T) {
	resetUserAgents(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "sca.md"),
		[]byte("---\nname: scanner\ntools: glob, grep, read\n---\nbody"), 0o644); err != nil {
		t.Fatal(err)
	}
	if warns := LoadUserAgents(dir); len(warns) != 0 {
		t.Fatalf("warnings = %v", warns)
	}
	byName := map[string]KindInfo{}
	for _, i := range KindInfos() {
		byName[i.Name] = i
	}
	if !byName["scanner"].ReadOnly {
		t.Error("read-tool allowlist should badge read-only")
	}
	if byName["code-reviewer"].ReadOnly != true || !byName["code-reviewer"].Builtin {
		t.Errorf("code-reviewer = %+v", byName["code-reviewer"])
	}
	if byName["general-purpose"].ReadOnly {
		t.Error("general-purpose should badge full tools")
	}
}

func TestKindNamesSortedForSchema(t *testing.T) {
	resetUserAgents(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "zz.md"),
		[]byte("---\nname: aardvark\n---\nbody"), 0o644); err != nil {
		t.Fatal(err)
	}
	LoadUserAgents(dir)
	names := KindNames()
	for i := 1; i < len(names); i++ {
		if names[i-1] >= names[i] {
			t.Fatalf("KindNames not sorted: %v", names)
		}
	}
	tt := NewTaskTool(SubagentConfig{Workdir: t.TempDir()})
	var schema struct {
		Properties struct {
			SubagentType struct {
				Enum []string `json:"enum"`
			} `json:"subagent_type"`
		} `json:"properties"`
	}
	if err := json.Unmarshal(tt.Schema(), &schema); err != nil {
		t.Fatalf("schema unmarshal: %v", err)
	}
	if len(schema.Properties.SubagentType.Enum) != len(names) {
		t.Fatalf("schema enum = %v, want %v", schema.Properties.SubagentType.Enum, names)
	}
	// The description advertises the user agent too.
	if !strings.Contains(tt.Description(), "aardvark") {
		t.Errorf("task description missing the user kind: %s", tt.Description())
	}
}

func TestDefaultToolNamesPinned(t *testing.T) {
	// effectiveTools' display list must match what tools.Default really
	// registers, or /agents lies about the general-purpose toolset.
	reg := tools.Default(t.TempDir())
	want := strings.Join(reg.Names(), ",")
	if got := strings.Join(defaultToolNames, ","); got != want {
		t.Fatalf("defaultToolNames = %q, tools.Default = %q", got, want)
	}
}

type fakeSrcTool struct{ name string }

func (f *fakeSrcTool) Name() string            { return f.name }
func (f *fakeSrcTool) Description() string     { return "fake" }
func (f *fakeSrcTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (f *fakeSrcTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	return "", nil
}
