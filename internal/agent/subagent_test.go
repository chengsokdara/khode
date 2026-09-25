package agent

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/llm"
	"khode/internal/perm"
)

func TestNormalizeKind(t *testing.T) {
	// Known names resolve to their spec; anything else falls back to
	// the general-purpose profile rather than erroring.
	cases := []struct {
		in   string
		want SubagentKind
		ro   bool
	}{
		{"", SubagentGeneral, false},
		{"general-purpose", SubagentGeneral, false},
		{"explore", SubagentExplore, true},
		{" context-gatherer ", SubagentGather, true},
		{"PLAN", SubagentPlan, true},
		{"no-such-kind", SubagentGeneral, false},
	}
	for _, c := range cases {
		kind, spec := normalizeKind(c.in)
		if kind != c.want || spec.ReadOnly != c.ro {
			t.Errorf("normalizeKind(%q) = %v readOnly=%v, want %v readOnly=%v",
				c.in, kind, spec.ReadOnly, c.want, c.ro)
		}
	}
}

func TestRegistryForReadOnlyKinds(t *testing.T) {
	// Read-only kinds expose only read/glob/grep, so no call from them
	// can ever need an approval or survive plan mode as a write.
	for _, kind := range []SubagentKind{SubagentExplore, SubagentGather, SubagentPlan} {
		reg := registryFor(kind, t.TempDir())
		for _, name := range reg.Names() {
			if reg.RiskOf(name) != perm.RiskRead {
				t.Errorf("%s registry: %s has risk %s", kind, name, reg.RiskOf(name))
			}
		}
		for _, want := range []string{"read", "glob", "grep"} {
			if _, ok := reg.Get(want); !ok {
				t.Errorf("%s registry missing %s", kind, want)
			}
		}
		for _, banned := range []string{"edit", "write", "bash", "task", "plan"} {
			if _, ok := reg.Get(banned); ok {
				t.Errorf("%s registry must not carry %s", kind, banned)
			}
		}
	}

	// general-purpose keeps the full default set (no task/plan: no
	// recursion) so existing task behavior is unchanged.
	reg := registryFor(SubagentGeneral, t.TempDir())
	for _, want := range []string{"edit", "write", "bash"} {
		if _, ok := reg.Get(want); !ok {
			t.Errorf("general registry missing %s", want)
		}
	}
}

func TestTaskToolExploreKindIsReadOnly(t *testing.T) {
	// An explore-kind subagent that tries to write finds no write tool:
	// the loop rejects the call as unknown, the subagent reports, and
	// nothing lands on disk.
	target := filepath.Join(t.TempDir(), "should-not-exist.txt")
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"write something","subagent_type":"explore"}`)}},
		},
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "s1", Name: "write",
				Input: json.RawMessage(`{"path":"` + target + `","content":"nope"}`)}},
		},
		{
			llm.TextDeltaEvent{Text: "no write tool available."},
		},
		{
			llm.TextDeltaEvent{Text: "done"},
		},
	}}
	r, _ := taskRunner(t, p, perm.ModeAsk)

	res, _ := callTask(t, r, "x")
	if res.IsError || res.Content != "no write tool available." {
		t.Fatalf("res = %+v", res)
	}
	if _, err := os.Stat(target); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("explore subagent wrote a file")
	}
}

func TestTaskToolExploreReportClipsToLowerCap(t *testing.T) {
	// The explore report cap is half the general cap; a report over it
	// truncates with the marker even though it would fit the general one.
	big := strings.Repeat("x", maxTaskResult/2+10)
	p := &fakeProvider{responses: [][]llm.Event{
		{
			llm.ToolCallEvent{ToolCall: llm.ToolCall{ID: "o1", Name: "task",
				Input: json.RawMessage(`{"prompt":"big","subagent_type":"explore"}`)}},
		},
		{
			llm.TextDeltaEvent{Text: big},
		},
		{
			llm.TextDeltaEvent{Text: "done"},
		},
	}}
	r, _ := taskRunner(t, p, perm.ModeAsk)

	res, _ := callTask(t, r, "big")
	if res.IsError {
		t.Fatalf("task failed: %s", res.Content)
	}
	if len(res.Content) != maxTaskResult/2 || !strings.HasSuffix(res.Content, "(…truncated)") {
		t.Fatalf("explore report = %d chars, want clipped to %d", len(res.Content), maxTaskResult/2)
	}
}

func TestTaskToolKindSectionInSystemPrompt(t *testing.T) {
	tt := NewTaskTool(SubagentConfig{Workdir: t.TempDir()})
	for _, kind := range []SubagentKind{SubagentExplore, SubagentGather, SubagentPlan} {
		spec := subagentKinds[kind]
		if !strings.Contains(tt.subagentSystem(spec), spec.Section) {
			t.Fatalf("%s system prompt missing its section", kind)
		}
	}
	// The general-purpose prompt carries no kind section beyond the
	// shared subagent preamble.
	general := tt.subagentSystem(subagentKinds[SubagentGeneral])
	for _, section := range []string{"# Explore", "# Context gatherer", "# Plan"} {
		if strings.Contains(general, section) {
			t.Fatalf("general-purpose should not carry %q", section)
		}
	}
}

func TestClipTaskResultPerKindCap(t *testing.T) {
	// The cap includes the marker: output is exactly cap bytes with the
	// truncation note at the end.
	got := clipTaskResult(strings.Repeat("y", 100), 40)
	if len(got) != 40 || !strings.HasSuffix(got, "(…truncated)") {
		t.Fatalf("clip = %d bytes ending %q", len(got), got[max(0, len(got)-20):])
	}
	if short := clipTaskResult("short", 40); short != "short" {
		t.Fatalf("short report clipped: %q", short)
	}
}
