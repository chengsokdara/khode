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
	// SubagentReview reviews specific code or a change, read-only, and
	// reports findings by severity.
	SubagentReview SubagentKind = "code-reviewer"
)

// kindSpec is one subagent profile.
type kindSpec struct {
	Label string // short name for status lines and progress
	// Description is the one-line summary /agents shows and the task
	// schema advertises alongside the kind name.
	Description string
	// ReadOnly restricts the kind to read/glob/grep. Every call is then
	// RiskRead: plan mode works and no approval dialog can fire.
	ReadOnly bool
	// Tools is an explicit allowlist for user-defined kinds; built-ins
	// leave it empty and use their ReadOnly/default toolset instead.
	// Names that do not resolve (see userTool) are dropped at spawn.
	Tools []string
	// Model pins the kind to a model, beating the global subagent
	// override; empty rides the configured subagent/main model.
	Model string
	// ReportCap clamps the report that reaches the parent.
	ReportCap int
	// Section is appended to the shared subagent system prompt; empty
	// for the general-purpose kind, whose preamble already fits.
	Section string
}

// subagentKinds is the catalog the task tool's schema enumerates; user
// kinds loaded from ~/.khode/agents join it at runtime (useragents.go).
var subagentKinds = map[SubagentKind]kindSpec{
	SubagentGeneral: {
		Label:       "general",
		Description: "your full toolset for open-ended subtasks, including any mutating work",
		ReportCap:   maxTaskResult,
	},
	SubagentExplore: {
		Label:       "explore",
		Description: "a fast read-only search answering where things live, with path:line pointers",
		ReadOnly:    true,
		ReportCap:   maxTaskResult / 2,
		Section: `# Explore

You are exploring read-only: answer where things are, not what they
contain. Name files and symbols with path:line pointers and state the
conclusion up front. Skim broadly with glob and grep, then read narrowly.
If what the prompt asks about does not exist, say so plainly.`,
	},
	SubagentGather: {
		Label:       "gather",
		Description: "builds a read-only brief on how the code supports a task; also runs automatically on a fresh session's first prompt",
		ReadOnly:    true,
		ReportCap:   maxTaskResult / 2,
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
		Label:       "plan",
		Description: "designs a read-only implementation approach the parent may present for approval",
		ReadOnly:    true,
		ReportCap:   maxTaskResult * 3 / 4,
		Section: `# Plan

You design an implementation approach, read-only. Investigate the code,
then end with a plan: the files to touch and what changes in each, the
order of work, the risks, and how to verify the result. The parent agent
receives only this report and may present it to the user for approval,
so it must be concrete enough to execute without re-deriving your
research.`,
	},
	SubagentReview: {
		Label:       "review",
		Description: "reviews named code or a change, read-only, and reports findings by severity",
		ReadOnly:    true,
		ReportCap:   maxTaskResult * 3 / 4,
		Section: `# Code reviewer

You review code, read-only. Investigate the files or change the prompt
names, then end with your findings, each as: severity (blocker /
should-fix / nit), the path:line, what is wrong, and the smallest fix
you would suggest. Verify every finding against the actual code — read
the surrounding context before calling something a bug — and say so
plainly when nothing is worth flagging. Do not restate what the code
does; the parent already has it.`,
	},
}

// normalizeKind resolves a model-supplied subagent_type; empty or
// unknown names fall back to the general-purpose profile.
func normalizeKind(s string) (SubagentKind, kindSpec) {
	k := SubagentKind(strings.ToLower(strings.TrimSpace(s)))
	if spec, ok := lookupKind(k); ok {
		return k, spec
	}
	return SubagentGeneral, subagentKinds[SubagentGeneral]
}

// registryFor builds a subagent's toolset. Built-in read-only kinds get
// only read/glob/grep; user kinds with a tools allowlist get exactly
// those (see userTool); the rest get the default set (which carries no
// task and no plan tool — subagents do not recurse and never open
// main-loop dialogs). src is the main registry MCP tools are borrowed
// from; nil restricts user kinds to the built-in constructors.
func registryFor(kind SubagentKind, workdir string, src *tools.Registry) *tools.Registry {
	spec, ok := lookupKind(kind)
	if ok {
		if spec.ReadOnly {
			r := tools.NewRegistry()
			r.Register(&tools.Read{Root: workdir})
			r.Register(&tools.Glob{Root: workdir})
			r.Register(&tools.Grep{Root: workdir})
			return r
		}
		if len(spec.Tools) > 0 {
			r := tools.NewRegistry()
			for _, name := range spec.Tools {
				if t := userTool(name, workdir, src); t != nil {
					r.Register(t)
				}
			}
			return r
		}
	}
	return tools.Default(workdir)
}

// GathererRegistry returns the read-only toolset the context-gatherer
// runs with, for callers that drive a gatherer runner directly (the
// UI's first-prompt gather).
func GathererRegistry(workdir string) *tools.Registry {
	return registryFor(SubagentGather, workdir, nil)
}

// GathererSystemPrompt is the system prompt for a context-gatherer run:
// the project context plus the brief contract.
func GathererSystemPrompt(workdir string) string {
	return subagentSystemPrompt(workdir, subagentKinds[SubagentGather])
}

// subagentSystemPrompt assembles a subagent's system prompt: project
// context, the shared reporting contract, and the kind's section.
func subagentSystemPrompt(workdir string, spec kindSpec) string {
	base := SystemPrompt(workdir) + `

# Subagent

You are running as a subagent spawned by the main agent for one task. You
have your own tools and a fresh context; nobody sees your intermediate
work. Work only on the given task, then end with a final message that is
a complete, self-contained report of what you found or changed — it is
the only part of your run the parent agent receives.`
	if spec.Section != "" {
		base += "\n\n" + spec.Section
	}
	return base
}
