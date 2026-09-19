package ui

import (
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// The bottom-pinning contract: after the first flush the frame's top
// plus its height lands exactly on the terminal bottom, and the frame
// returns there after height changes (refill on shrink, scroll on
// growth).
func TestFlushPinsFrameBottom(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	if m.top+m.hModel != 30 {
		t.Fatalf("after boot: top %d + hModel %d = %d, want 30", m.top, m.hModel, 30)
	}
	if h := lipgloss.Height(m.View().Content); h != m.hModel {
		t.Fatalf("hModel %d does not match the rendered view height %d", m.hModel, h)
	}
	// The banner rode the chunk with the fill.
	if !strings.Contains(ansiStrip(m.lastPrint), "khode") {
		t.Errorf("boot chunk missing the banner: %q", m.lastPrint)
	}
}

// Growing the frame (settings overlay) keeps the bottom glued; closing
// it shrinks the frame and the delayed refill re-fills the delta.
func TestFrameHeightChangesStayPinned(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// Open the settings overlay through a real Update (the wrapper
	// tracks the growth) and settle the render with a pin tick.
	m.OpenSettings(rowProvider)
	next, _ = m.Update(pinTick{})
	m = next.(Model)
	h := lipgloss.Height(m.View().Content)
	if m.top+h != 30 {
		t.Fatalf("overlay open: top %d + height %d = %d, want 30", m.top, h, 30)
	}

	// Close it with esc (a real update — the wrapper schedules the
	// refill one tick later), then run the refill: the delta fills.
	m = pressKeys(m, "esc")
	next, _ = m.Update(pinTick{})
	m = next.(Model)
	if m.top+m.hModel != 30 {
		t.Fatalf("after close: top %d + hModel %d = %d, want 30", m.top, m.hModel, 30)
	}

	// Settled: further refills are no-ops.
	next, _ = m.Update(pinTick{})
	m = next.(Model)
	if m.top+m.hModel != 30 {
		t.Fatalf("settled: top %d + hModel %d = %d, want 30", m.top, m.hModel, 30)
	}
}

// Sealing while pinned keeps the pin: the scroll regime re-anchors the
// frame by itself, so top stays put across a big chunk.
func TestFlushSealKeepsPin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	before := m.top
	m.command("/help") // seals well more than the 5-row frame
	if m.top != before {
		t.Fatalf("seal moved the tracked top: %d -> %d", before, m.top)
	}
	if m.top+m.hModel != 30 {
		t.Fatalf("after seal: top %d + hModel %d = %d, want 30", m.top, m.hModel, 30)
	}
}
