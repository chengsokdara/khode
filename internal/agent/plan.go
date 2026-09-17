package agent

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	"khode/internal/perm"
	"khode/internal/tools"
)

// Plan workflow: in plan mode the model investigates (read-only) and
// then presents a whole-task plan with this tool. Approving it in the
// TUI switches khode to accept-edits mode for implementation.

// PlanTool presents a plan for the user to approve or decline.
type PlanTool struct {
	Bridge *Bridge
	// Mode reports the live permission mode; the plan tool is only
	// meaningful in plan mode.
	Mode func() perm.Mode
}

// NewPlanTool builds the plan tool.
func NewPlanTool(bridge *Bridge, mode func() perm.Mode) *PlanTool {
	return &PlanTool{Bridge: bridge, Mode: mode}
}

func (p *PlanTool) Name() string { return "plan" }

func (p *PlanTool) Description() string {
	return "Present your plan for the current task as markdown for the user to " +
		"review. Use it in plan mode: investigate first, then call this once " +
		"with the complete plan — goal, steps, files to touch, and risks. If " +
		"the user approves, khode switches to accept-edits mode and you may " +
		"implement; if they decline, refine the plan or ask what to change."
}

func (p *PlanTool) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "properties": {
    "plan": {"type": "string", "description": "The complete plan in markdown"}
  },
  "required": ["plan"]
}`)
}

// Risk is read: presenting a plan changes nothing, which is what keeps
// the tool callable inside plan mode.
func (p *PlanTool) Risk() perm.Risk { return perm.RiskRead }

func (p *PlanTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var a struct {
		Plan string `json:"plan"`
	}
	if err := json.Unmarshal(args, &a); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if strings.TrimSpace(a.Plan) == "" {
		return "", fmt.Errorf("plan is required")
	}
	if mode := p.Mode(); mode != perm.ModePlan {
		return "", fmt.Errorf("the plan tool is for plan mode (current: %s) — just do the work", mode)
	}

	if !p.Bridge.ApprovePlan(ctx, a.Plan) {
		if err := ctx.Err(); err != nil {
			return "", err // cancelled: the loop's interruption wording wins
		}
		return "", errors.New("the user declined this plan — refine it or ask what they would like changed")
	}
	return "the user approved the plan — khode switched to accept-edits mode; implement it", nil
}

// interface guards: the plan tool satisfies the tool contract.
var (
	_ tools.Tool           = (*PlanTool)(nil)
	_ tools.RiskClassifier = (*PlanTool)(nil)
)
