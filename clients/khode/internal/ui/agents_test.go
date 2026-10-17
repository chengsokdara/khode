package ui

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"

	tea "charm.land/bubbletea/v2"
)

// TestAgentsPanelListsKinds opens /agents and checks the built-in
// profiles render with their badges.
func TestAgentsPanelListsKinds(t *testing.T) {
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	m.command("/agents")
	if m.agentsPanel == nil {
		t.Fatal("/agents did not open the panel")
	}
	view := ansiStrip(m.agentsView())
	if !strings.Contains(view, "code-reviewer") || !strings.Contains(view, "explore") {
		t.Errorf("panel missing built-in kinds: %q", view)
	}
	if !strings.Contains(view, "read-only") {
		t.Errorf("panel missing the read-only badge: %q", view)
	}
	if !strings.Contains(view, "7 tools") {
		t.Errorf("panel missing the general-purpose tool-count badge: %q", view)
	}
	if !strings.Contains(view, "general-purpose") {
		t.Errorf("panel missing general-purpose: %q", view)
	}

	// esc closes back to the chat.
	m = pressKeys(m, "esc")
	if m.agentsPanel != nil {
		t.Fatal("esc did not close the panel")
	}
}

// TestAgentsPanelReloadUserAgents writes user agent files into the
// isolated HOME's agents dir, reloads with r, and checks the new kind
// shows up in the list and in the task tool's schema.
func TestAgentsPanelReloadUserAgents(t *testing.T) {
	m := newTestModel(t)
	t.Cleanup(func() { agent.LoadUserAgents(t.TempDir()) })

	dir := config.AgentsDir() // HOME is isolated, so this is a temp dir
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "doc-writer.md"), []byte(`---
name: doc-writer
description: writes and improves project documentation
tools: read, glob, grep, write
---

Write docs.`), 0o644); err != nil {
		t.Fatal(err)
	}
	// A clashing file must surface as a warning, not shadow a built-in.
	if err := os.WriteFile(filepath.Join(dir, "clash.md"), []byte("---\nname: plan\ndescription: nope\n---\nnope"), 0o644); err != nil {
		t.Fatal(err)
	}

	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.command("/agents")
	m = pressKeys(m, "r")

	view := ansiStrip(m.agentsView())
	if !strings.Contains(view, "doc-writer") {
		t.Errorf("reloaded panel missing the user kind: %q", view)
	}
	if !strings.Contains(view, "built-in") {
		t.Errorf("reloaded panel missing the built-in clash warning: %q", view)
	}
	if !strings.Contains(view, "reloaded") {
		t.Errorf("reloaded panel missing the flash: %q", view)
	}

	// The loaded kind reaches the task tool's enum for the model.
	names := agent.KindNames()
	found := false
	for _, n := range names {
		if n == "doc-writer" {
			found = true
		}
	}
	if !found {
		t.Errorf("KindNames = %v, want doc-writer", names)
	}
}

// TestAgentsRowClickMovesCursor applies the row convention: clicking a
// row moves the cursor, and the overview activates nothing.
func TestAgentsRowClickMovesCursor(t *testing.T) {
	m := newTestModel(t)
	m.command("/agents")
	m.rowClick(2)
	if m.agentsPanel.cursor != 2 {
		t.Fatalf("cursor = %d, want 2", m.agentsPanel.cursor)
	}
}
