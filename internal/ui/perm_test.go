package ui

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
)

// startDialog asks a permission through the model's bridge the way the
// agent loop would, and returns the channel carrying the UI's answer.
func startDialog(m *Model, call llm.ToolCall, risk perm.Risk) <-chan bool {
	approved := make(chan bool, 1)
	go func() {
		approved <- m.approvals.Approve(context.Background(), call, risk,
			"@@ -1,1 +1,1 @@\n-old\n+new")
	}()
	return approved
}

// pumpUntilDialog polls the real waitForEvents chain until the approval
// dialog opens.
func pumpUntilDialog(t *testing.T, m Model) Model {
	t.Helper()
	for m.perm == nil {
		msg := waitForEvents(m.events, m.approvals.Requests())()
		next, _ := m.Update(msg)
		m = next.(Model)
	}
	return m
}

func TestApprovalDialogAllowAndDeny(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true
	m.events = make(chan llm.Event) // never delivers; the bridge is the only traffic

	call := llm.ToolCall{ID: "c1", Name: "edit", Input: json.RawMessage(`{"path":"a.go"}`)}
	approved := startDialog(&m, call, perm.RiskWrite)

	m = pumpUntilDialog(t, m)
	if v := m.View().Content; !strings.Contains(v, "permission") || !strings.Contains(v, "a.go") {
		t.Errorf("dialog view missing title/target: %q", v)
	}

	// y allows: the answer reaches the waiting Approver and closes the dialog.
	next, _ = m.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	m = next.(Model)
	if m.perm != nil {
		t.Error("dialog still open after allow")
	}
	if !<-approved {
		t.Error("allow did not reach the approver")
	}

	// esc denies a second request.
	approved = startDialog(&m, call, perm.RiskWrite)
	m = pumpUntilDialog(t, m)
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(Model)
	if m.perm != nil {
		t.Error("dialog still open after deny")
	}
	if <-approved {
		t.Error("deny was not delivered")
	}
}

// A question arriving with no live turn is declined without a dialog.
func TestStalePermRequestDeclined(t *testing.T) {
	m := newTestModel(t)
	approved := startDialog(&m, llm.ToolCall{ID: "c1", Name: "bash", Input: json.RawMessage(`{}`)}, perm.RiskExec)

	msg := waitForEvents(m.events, m.approvals.Requests())()
	next, _ := m.Update(msg)
	m = next.(Model)

	if m.perm != nil {
		t.Error("stale request opened a dialog")
	}
	if <-approved {
		t.Error("stale request was not declined")
	}
}

func TestPermViewRendersDiff(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	req := agent.Request{
		Call:    llm.ToolCall{ID: "c1", Name: "write", Input: json.RawMessage(`{"path":"docs/x.md"}`)},
		Risk:    perm.RiskWrite,
		Preview: "@@ -1,2 +1,2 @@\n-old line\n+new line",
	}
	m.perm = &req

	v := m.View().Content
	if !strings.Contains(v, "write") || !strings.Contains(v, "docs/x.md") {
		t.Errorf("view missing tool/target: %q", v)
	}
	if !strings.Contains(v, "-old line") || !strings.Contains(v, "+new line") {
		t.Errorf("view missing diff: %q", v)
	}
	if !strings.Contains(v, "allow") || !strings.Contains(v, "deny") {
		t.Errorf("view missing keys help: %q", v)
	}
}

func TestModeCommand(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// Bare /mode opens the picker with the cursor on the active mode
	// (ask, the default).
	m.command("/mode")
	if m.modePick == nil {
		t.Fatal("bare /mode did not open the mode picker")
	}
	if v := m.modePickView(); !strings.Contains(v, "plan") || !strings.Contains(v, "accept-edits") {
		t.Errorf("/mode picker view = %q", v)
	}
	if m.modePick.cursor != 1 {
		t.Errorf("picker cursor = %d, want 1 (on ask)", m.modePick.cursor)
	}
	m.closeModePicker()

	m.command("/mode plan")
	if m.mode() != perm.ModePlan {
		t.Errorf("mode after /mode plan = %q", m.mode())
	}

	// The switch persists to the config file.
	cfg, err := config.Load()
	if err != nil {
		t.Fatalf("reload config: %v", err)
	}
	if cfg.PermissionMode != "plan" {
		t.Errorf("persisted mode = %q, want plan", cfg.PermissionMode)
	}

	m.command("/mode yolo")
	last := m.messages[len(m.messages)-1].raw
	if !strings.Contains(last, "unknown mode") {
		t.Errorf("invalid mode response = %q", last)
	}
	if m.mode() != perm.ModePlan {
		t.Errorf("invalid mode changed the mode to %q", m.mode())
	}
}

func TestPlanApprovalSwitchesMode(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true
	m.events = make(chan llm.Event)

	// The agent side presents a plan through the bridge, like the plan
	// tool does; the answer comes back through the keypress flow below.
	approved := make(chan bool, 1)
	go func() {
		approved <- m.approvals.ApprovePlan(context.Background(), "# the plan\ndo things")
	}()

	m = pumpUntilDialog(t, m)
	if m.perm == nil || m.perm.Kind != agent.KindPlan {
		t.Fatalf("dialog kind = %v, want KindPlan", m.perm)
	}
	if v := m.View().Content; !strings.Contains(v, "plan") || !strings.Contains(v, "do things") {
		t.Errorf("plan dialog view = %q", v)
	}

	next, _ = m.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	m = next.(Model)
	if m.perm != nil {
		t.Error("plan dialog still open after approval")
	}
	if m.mode() != perm.ModeAcceptEdits {
		t.Errorf("mode after plan approval = %q, want accept-edits", m.mode())
	}
	cfg, err := config.Load()
	if err != nil || cfg.PermissionMode != string(perm.ModeAcceptEdits) {
		t.Errorf("persisted mode = %q (err %v), want accept-edits", cfg.PermissionMode, err)
	}
	if !<-approved {
		t.Error("approval did not reach the waiting plan tool")
	}
}

// shift+tab inside a tool dialog cycles the mode; when the new mode
// would have allowed the pending call outright, the dialog answers
// itself and the turn keeps going.
func TestPermDialogShiftTabAutoResolves(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true
	m.events = make(chan llm.Event) // never delivers; the bridge is the only traffic

	approved := startDialog(&m, llm.ToolCall{ID: "c1", Name: "edit", Input: json.RawMessage(`{"path":"a.go"}`)}, perm.RiskWrite)
	m = pumpUntilDialog(t, m)

	// ask → accept-edits: the write no longer needs asking, so the
	// dialog approves itself on the cycle.
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})
	m = next.(Model)
	if m.mode() != perm.ModeAcceptEdits {
		t.Errorf("mode after shift+tab = %q, want accept-edits", m.mode())
	}
	if m.perm != nil {
		t.Error("dialog still open after cycling to a mode that allows the call")
	}
	if !<-approved {
		t.Error("auto-approval did not reach the waiting approver")
	}
	cfg, err := config.Load()
	if err != nil || cfg.PermissionMode != string(perm.ModeAcceptEdits) {
		t.Errorf("persisted mode = %q (err %v), want accept-edits", cfg.PermissionMode, err)
	}
}

// A question the new mode still asks about (bash under accept-edits)
// stays open for a manual answer.
func TestPermDialogShiftTabKeepsExecAsk(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true
	m.events = make(chan llm.Event)

	approved := startDialog(&m, llm.ToolCall{ID: "c1", Name: "bash", Input: json.RawMessage(`{}`)}, perm.RiskExec)
	m = pumpUntilDialog(t, m)

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})
	m = next.(Model)
	if m.mode() != perm.ModeAcceptEdits {
		t.Errorf("mode after shift+tab = %q, want accept-edits", m.mode())
	}
	if m.perm == nil {
		t.Fatal("exec dialog closed although accept-edits still asks for commands")
	}
	if v := m.View().Content; !strings.Contains(v, "permission") {
		t.Errorf("dialog view lost after mode cycle: %q", v)
	}

	// The manual answer still works after the cycle.
	next, _ = m.Update(tea.KeyPressMsg{Code: 'y', Text: "y"})
	m = next.(Model)
	if m.perm != nil {
		t.Error("dialog still open after allow")
	}
	if !<-approved {
		t.Error("allow did not reach the approver")
	}
}

// Mode cycling never answers a plan dialog: the approval stays the
// user's, while the mode itself follows shift+tab.
func TestPermDialogShiftTabLeavesPlanOpen(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true
	m.events = make(chan llm.Event)
	m.setMode(perm.ModePlan) // the plan dialog belongs to plan mode

	approved := make(chan bool, 1)
	go func() {
		approved <- m.approvals.ApprovePlan(context.Background(), "# the plan\ndo things")
	}()
	m = pumpUntilDialog(t, m)

	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift})
	m = next.(Model)
	if m.mode() != perm.ModeAsk {
		t.Errorf("mode after shift+tab = %q, want ask (cycled from plan)", m.mode())
	}
	if m.perm == nil || m.perm.Kind != agent.KindPlan {
		t.Fatal("plan dialog did not stay open on mode cycle")
	}

	// esc denies; the mode stays where the cycle left it.
	next, _ = m.Update(tea.KeyPressMsg{Code: tea.KeyEscape})
	m = next.(Model)
	if m.perm != nil {
		t.Error("plan dialog still open after deny")
	}
	if <-approved {
		t.Error("deny was not delivered")
	}
	if m.mode() != perm.ModeAsk {
		t.Errorf("mode after deny = %q, want ask", m.mode())
	}
}
