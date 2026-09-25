package ui

import (
	"encoding/json"
	"strings"
	"testing"

	"khode/internal/llm"

	tea "charm.land/bubbletea/v2"
)

// driveTaskWithProgress simulates a task call whose child reports one
// progress line, then finishes: the activity renders dim under the call
// line while it runs and is gone once the report lands.
func driveTaskWithProgress(t *testing.T) Model {
	t.Helper()
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m.streaming = true

	next, _ = m.Update(streamEventMsg{ev: llm.ToolCallEvent{ToolCall: llm.ToolCall{
		ID: "t1", Name: "task",
		Input: json.RawMessage(`{"prompt":"sweep","description":"find todos","subagent_type":"explore"}`),
	}}})
	m = next.(Model)

	next, _ = m.Update(taskProgressMsg{Kind: "explore", Activity: "grep TODO", Calls: 2})
	m = next.(Model)
	return m
}

func TestTaskProgressLineRendersWhileRunning(t *testing.T) {
	m := driveTaskWithProgress(t)

	if m.activeTaskID != "t1" {
		t.Fatalf("activeTaskID = %q", m.activeTaskID)
	}
	var blk string
	for i, msg := range m.messages {
		if msg.kind == kindToolCall && strings.Contains(msg.raw, "task") {
			blk = ansiStrip(m.block(i, 100))
		}
	}
	if !strings.Contains(blk, "explore · grep TODO · 2 calls") {
		t.Errorf("task call block missing live activity: %q", blk)
	}
}

func TestTaskProgressLineClearsOnResult(t *testing.T) {
	m := driveTaskWithProgress(t)

	next, _ := m.Update(streamEventMsg{ev: llm.ToolResultEvent{
		CallID: "t1", Name: "task", Output: "the gathered report",
	}})
	m = next.(Model)

	if m.activeTaskID != "" || m.activeTask != -1 {
		t.Fatalf("active task not cleared: %d %q", m.activeTask, m.activeTaskID)
	}
	for i, msg := range m.messages {
		if msg.kind == kindToolCall {
			if out := ansiStrip(m.block(i, 100)); strings.Contains(out, "grep TODO") {
				t.Errorf("activity line survived the result: %q", out)
			}
		}
		if msg.kind == kindToolResult && !strings.Contains(ansiStrip(m.block(i, 100)), "the gathered report") {
			t.Errorf("result block missing report: %q", ansiStrip(m.block(i, 100)))
		}
	}
}

func TestTaskProgressWithoutActiveTaskIsIgnored(t *testing.T) {
	// A progress line with no in-flight task (turn already finished,
	// stale send) must not panic or append anything.
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	before := len(m.messages)
	next, _ = m.Update(taskProgressMsg{Kind: "explore", Activity: "grep x", Calls: 1})
	m = next.(Model)
	if len(m.messages) != before {
		t.Fatalf("stale progress appended a block")
	}
}
