package agent

import (
	"strings"

	"khode/internal/tools"
)

// Built-in subagent kinds behind the task tool. A kind fixes the
// toolset, the system-prompt section, and the report budget, so the
// parent picks a profile instead of describing one every call.

// SubagentKind selects a built-in subagent profile.
type SubagentKind string

const (
	// SubagentGeneral is the default profile: the full toolset for
	// open-ended work whose intermediate output the parent discards.
	SubagentGeneral SubagentKind = "general-purpose"
	// SubagentExplore is a fast read-only searcher that answers "where
	// is this?" with path:line pointers, not file dumps.
	SubagentExplore SubagentKind = "explore"
	// SubagentGather sweeps the repository read-only and returns a
	// structured brief for a task; the UI runs it on the first prompt
	// of a new session.
	SubagentGather SubagentKind = "context-gatherer"
	// SubagentPlan is a read-only designer of implementation approaches
	// the parent may present for approval.
	SubagentPlan SubagentKind = "plan"
)

// kindSpec is one subagent profile.
type kindSpec struct {
	Label string // short name for status lines and progress
	// ReadOnly restricts the kind to read/glob/grep. Every call is then
	// RiskRead: plan mode works and no approval dialog can fire.
	ReadOnly bool
	// ReportCap clamps the report that reaches the parent.
	ReportCap int
	// Section is appended to the shared subagent system prompt; empty
	// for the general-purpose kind, whose preamble already fits.
	Section string
}

// subagentKinds is the catalog the task tool's schema enumerates.
var subagentKinds = map[SubagentKind]kindSpec{
	SubagentGeneral: {Label: "general", ReportCap: maxTaskResult},
	SubagentExplore: {
		Label:     "explore",
		ReadOnly:  true,
		ReportCap: maxTaskResult / 2,
		Section: `# Explore

You are exploring read-only: answer where things are, not what they
contain. Name files and symbols with path:line pointers and state the
conclusion up front. Skim broadly with glob and grep, then read narrowly.
If what the prompt asks about does not exist, say so plainly.`,
	},
	SubagentGather: {
		Label:     "gather",
		ReadOnly:  true,
		ReportCap: maxTaskResult / 2,
		Section: `# Context gatherer

You sweep the repository read-only to build a brief that another agent
will act on, so everything you write lands verbatim in its context
window. Investigate the request against the actual code, then end with
ONLY the brief, in this shape:

## Summary
Two to four sentences on what the task touches and how the code is
organized around it.

## Key files
- path:line — why it matters for this task

## Conventions
Only the load-bearing ones — patterns, invariants, guidance files — the
implementer must respect.

## Risks & unknowns
What could bite or remains unclear.

Keep it tight; prefer pointers over prose. If the request is not a real
coding task, reply with a single sentence saying so.`,
	},
	SubagentPlan: {
		Label:     "plan",
		ReadOnly:  true,
		ReportCap: maxTaskResult * 3 / 4,
		Section: `# Plan

You design an implementation approach, read-only. Investigate the code,
then end with a plan: the files to touch and what changes in each, the
order of work, the risks, and how to verify the result. The parent agent
receives only this report and may present it to the user for approval,
so it must be concrete enough to execute without re-deriving your
research.`,
	},
}

// normalizeKind resolves a model-supplied subagent_type; empty or
// unknown names fall back to the general-purpose profile.
func normalizeKind(s string) (SubagentKind, kindSpec) {
	k := SubagentKind(strings.ToLower(strings.TrimSpace(s)))
	if spec, ok := subagentKinds[k]; ok {
		return k, spec
	}
	return SubagentGeneral, subagentKinds[SubagentGeneral]
}

// registryFor builds a subagent's toolset: read-only kinds get only
// read/glob/grep, the rest the default set (which carries no task and no
// plan tool — subagents do not recurse and never open main-loop dialogs).
func registryFor(kind SubagentKind, workdir string) *tools.Registry {
	if subagentKinds[kind].ReadOnly {
		r := tools.NewRegistry()
		r.Register(&tools.Read{Root: workdir})
		r.Register(&tools.Glob{Root: workdir})
		r.Register(&tools.Grep{Root: workdir})
		return r
	}
	return tools.Default(workdir)
}
