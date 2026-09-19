package ui

import (
	"fmt"
	"strings"
	"testing"

	"khode/internal/tools"

	tea "charm.land/bubbletea/v2"
)

func newToolsModel(t *testing.T, reg *tools.Registry) Model {
	t.Helper()
	m := newSettingsModel(t)
	m.tools = reg
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.openTools()
	if m.toolsPanel == nil {
		t.Fatal("panel did not open")
	}
	return m
}

func TestToolsPanelToggleAndClose(t *testing.T) {
	m := newToolsModel(t, tools.Default(t.TempDir()))
	n := len(m.toolsPanel.names)
	if n < 2 {
		t.Fatalf("panel lists %d tools, want at least 2", n)
	}

	// Enter disables the tool under the cursor; the view reflects it.
	name := m.toolsPanel.names[0]
	m = pressKeys(m, "enter")
	if m.tools.Enabled(name) {
		t.Errorf("%s still enabled after enter", name)
	}
	if view := m.View().Content; !strings.Contains(view, fmt.Sprintf("1/%d off", n)) {
		t.Errorf("view missing off-count after toggle: %q", view)
	}

	// Space is a synonym of enter, so it toggles back on.
	m = pressKeys(m, " ")
	if !m.tools.Enabled(name) {
		t.Errorf("%s not re-enabled by space", name)
	}

	// The cursor moves and the panel closes without side effects.
	m = pressKeys(m, "down", "down")
	if m.toolsPanel.cursor != 2 {
		t.Fatalf("cursor = %d, want 2", m.toolsPanel.cursor)
	}
	m = pressKeys(m, "esc")
	if m.toolsPanel != nil {
		t.Error("esc did not close the panel")
	}
	for _, other := range m.tools.Names()[1:] {
		if !m.tools.Enabled(other) {
			t.Errorf("navigation toggled %s", other)
		}
	}
}

func TestToolsPanelEmptyRegistry(t *testing.T) {
	m := newToolsModel(t, tools.NewRegistry())
	if view := m.View().Content; !strings.Contains(view, "no tools registered") {
		t.Errorf("empty registry view = %q", view)
	}
}
