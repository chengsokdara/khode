package ui

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"khode/internal/config"
	"khode/internal/mcp"
	"khode/internal/tools"

	tea "charm.land/bubbletea/v2"
)

// mcpFakeTool is a registry stand-in for one MCP tool.
type mcpFakeTool struct{ name string }

func (t mcpFakeTool) Name() string            { return t.name }
func (t mcpFakeTool) Description() string     { return "fake " + t.name }
func (t mcpFakeTool) Schema() json.RawMessage { return json.RawMessage(`{"type":"object"}`) }
func (t mcpFakeTool) Exec(context.Context, json.RawMessage) (string, error) {
	return "ok", nil
}

func newMCPRegistry(names ...string) *tools.Registry {
	reg := tools.NewRegistry()
	for _, n := range names {
		reg.Register(mcpFakeTool{name: n})
	}
	return reg
}

func TestMCPPanelRowsAndStatus(t *testing.T) {
	m := newSettingsModel(t)
	m.cfg.MCPServers = map[string]config.MCPServer{
		"zeta":  {Command: "/bin/false"},
		"alpha": {Command: "uvx", Args: []string{"srv"}, Risk: "read"},
	}
	m.tools = newMCPRegistry("mcp__alpha__one", "mcp__alpha__two", "mcp__zeta__only")
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m.openMCPPanel()
	if p := m.mcpPanel; p == nil || len(p.names) != 2 || p.names[0] != "alpha" || p.names[1] != "zeta" {
		t.Fatalf("open state = %+v, want sorted [alpha zeta]", m.mcpPanel)
	}

	// Nothing running yet: both rows read unavailable.
	if v := m.View().Content; !strings.Contains(v, "unavailable") || !strings.Contains(v, "2 servers") {
		t.Errorf("view missing unavailable rows: %q", v)
	}

	// A running client flips the row to its tool count; the detail block
	// lists the tool short names.
	m.mcpClients = map[string]*mcp.Client{"alpha": {}}
	if v := m.View().Content; !strings.Contains(v, "2 tools") || !strings.Contains(v, "tools: one, two") {
		t.Errorf("running row missing tools summary: %q", v)
	}

	// Disabled tools show the off-count.
	m.tools.SetEnabled("mcp__alpha__one", false)
	if v := m.View().Content; !strings.Contains(v, "(1 off)") {
		t.Errorf("view missing off-count: %q", v)
	}
}

func TestMCPPanelRestartAction(t *testing.T) {
	m := newSettingsModel(t)
	m.cfg.MCPServers = map[string]config.MCPServer{
		"alpha": {Command: "uvx", Args: []string{"srv"}},
	}
	m.tools = newMCPRegistry("mcp__alpha__one")
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.openMCPPanel()

	// enter schedules the reconcile and marks the row busy; a second
	// press while busy is ignored. The cmd is never executed in tests.
	cmd := m.mcpPanelKey(keyMsg("enter"))
	if cmd == nil {
		t.Fatal("enter scheduled no reconcile")
	}
	if !m.mcpPanel.busy["alpha"] {
		t.Fatal("enter did not mark the server busy")
	}
	if cmd = m.mcpPanelKey(keyMsg("enter")); cmd != nil {
		t.Fatal("busy server accepted a second reconcile")
	}

	// The result clears the busy mark and reports as usual.
	m.applyMCPResult(mcpApplyMsg{problems: []string{"alpha unavailable: boom"}})
	if m.mcpPanel.busy != nil && m.mcpPanel.busy["alpha"] {
		t.Fatal("busy mark survived the result")
	}
	if last := m.messages[len(m.messages)-1].raw; !strings.Contains(last, "alpha unavailable: boom") {
		t.Errorf("result notice = %q", last)
	}

	// esc closes.
	if cmd = m.mcpPanelKey(keyMsg("esc")); cmd != nil {
		t.Fatalf("esc returned %T", cmd())
	}
	if m.mcpPanel != nil {
		t.Fatal("panel open after esc")
	}
}

func TestMCPPanelToggleTools(t *testing.T) {
	m := newSettingsModel(t)
	m.cfg.MCPServers = map[string]config.MCPServer{
		"alpha": {Command: "uvx"},
		"empty": {Command: "/bin/false"},
	}
	m.tools = newMCPRegistry("mcp__alpha__one", "mcp__alpha__two")
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.openMCPPanel()

	// space on alpha (cursor row) disables both of its tools.
	m.mcpPanelKey(keyMsg(" "))
	for _, tn := range []string{"mcp__alpha__one", "mcp__alpha__two"} {
		if m.tools.Enabled(tn) {
			t.Errorf("%s still enabled after space", tn)
		}
	}
	// space again re-enables both.
	m.mcpPanelKey(keyMsg(" "))
	for _, tn := range []string{"mcp__alpha__one", "mcp__alpha__two"} {
		if !m.tools.Enabled(tn) {
			t.Errorf("%s not re-enabled by space", tn)
		}
	}

	// Mixed state counts as "not all on" → space turns everything on.
	m.tools.SetEnabled("mcp__alpha__two", false)
	m.mcpPanelKey(keyMsg(" "))
	if !m.tools.Enabled("mcp__alpha__two") {
		t.Error("mixed state did not re-enable all tools")
	}

	// space on a server with no registered tools is a safe no-op.
	m.mcpPanelKey(keyMsg("down")) // cursor → empty
	m.mcpPanelKey(keyMsg(" "))
}

func TestMCPPanelEmptyConfig(t *testing.T) {
	m := newSettingsModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.openMCPPanel()

	if v := m.View().Content; !strings.Contains(v, "no MCP servers configured") {
		t.Errorf("empty view = %q", v)
	}
	if cmd := m.mcpPanelKey(keyMsg("enter")); cmd != nil {
		t.Error("enter on an empty list scheduled work")
	}
	if cmd := m.mcpPanelKey(keyMsg(" ")); cmd != nil {
		t.Error("space on an empty list did work")
	}
}
