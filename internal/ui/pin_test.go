package ui

import (
	"fmt"
	"strings"
	"testing"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// historyOf renders what the user sees of sealed history: the printed
// scrollback chunk plus the band's tail lines.
func historyOf(m Model) string {
	lines := append([]string{}, m.tail...)
	if m.lastPrint != "" {
		lines = append([]string{m.lastPrint}, lines...)
	}
	return strings.Join(lines, "\n")
}

// At boot the frame floats under its content: the banner lands in the
// band's tail (nothing prints, no blank filler), and the band renders
// it above the input.
func TestBootTailAbsorbsBanner(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	if m.lastPrint != "" {
		t.Errorf("boot printed %q, want the banner absorbed into the tail", m.lastPrint)
	}
	if len(m.tail) == 0 || !strings.Contains(strings.Join(m.tail, "\n"), "/help commands") {
		t.Errorf("tail missing the banner: %q", m.tail)
	}
	if m.top != 0 {
		t.Errorf("boot top = %d, want 0 (floating)", m.top)
	}
	band := m.transientBand()
	if !strings.Contains(strings.Join(band, "\n"), "/help commands") {
		t.Errorf("band does not render the tail: %q", band)
	}
}

// Seals displace tail lines into scrollback; once the displaced volume
// pushes the frame to the bottom edge it pins there and stays.
func TestSealsDisplaceAndPin(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// Enough bulk seals to overflow the band's 40-line buffer and pin
	// the frame.
	for i := range 50 {
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("line %d", i)})
	}
	if cmd := m.flush(); cmd == nil {
		t.Fatal("overflow seal printed nothing")
	}
	if m.lastPrint == "" {
		t.Fatal("displaced lines were not printed")
	}
	if m.top+m.hModel != 30 {
		t.Fatalf("after overflow: top %d + hModel %d = %d, want 30 (pinned)", m.top, m.hModel, 30)
	}
	if len(m.tail) > tailKeep {
		t.Fatalf("tail = %d lines, over the %d-line buffer", len(m.tail), tailKeep)
	}
	// The band displays the window: base 11 lines plus any extension.
	if want := transientBandTail + m.bandExtra; len(m.transientBand()) != want+1 {
		t.Fatalf("band = %d rows, want %d (slot %d + mode line)", len(m.transientBand()), want+1, want)
	}

	// Further seals keep the pin and slide the tail forward.
	before := m.top
	m.command("/help")
	if m.top != before {
		t.Fatalf("seal moved the pinned frame: %d -> %d", before, m.top)
	}
	if m.top+m.hModel != 30 {
		t.Fatalf("after seal: top %d + hModel %d = %d, want 30", m.top, m.hModel, 30)
	}
}

// A popup overlays the tail in the band: the frame height is constant,
// the tail survives underneath, and closing restores the history rows.
func TestPopupOverlaysTail(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// Fill the tail with history past the band's base size, so the
	// popup overlays a full window and nothing moves.
	for i := range 15 {
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("alpha line %d", i)})
	}
	m.flush()
	next, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	hBefore := lipgloss.Height(m.View().Content)
	tailBefore := strings.Join(m.tail, "\n")
	m = pressKeys(m, "/")
	if m.popup == nil {
		t.Fatal("popup did not open")
	}
	if h := lipgloss.Height(m.View().Content); h != hBefore {
		t.Errorf("frame height with popup = %d, want %d (band is fixed)", h, hBefore)
	}
	band := strings.Join(m.transientBand(), "\n")
	if !strings.Contains(band, "enter run") {
		t.Errorf("band does not show the popup: %q", band)
	}
	m = pressKeys(m, "esc")
	if m.popup != nil {
		t.Fatal("popup still open")
	}
	if h := lipgloss.Height(m.View().Content); h != hBefore {
		t.Errorf("frame height after close = %d, want %d", h, hBefore)
	}
	if got := strings.Join(m.transientBand(), "\n"); !strings.Contains(got, "alpha") {
		t.Errorf("band does not restore the tail after close: %q", got)
	}
	if strings.Join(m.tail, "\n") != tailBefore {
		t.Error("tail changed across the popup cycle")
	}
}

// An overlay transition leaves dead space below the frame; the band
// grows to fill it with deeper history instead of letting the input
// float.
func TestBandFillsOverlayDeadSpace(t *testing.T) {
	t.Setenv("HOME", t.TempDir())
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// Fill the tail first: with no history the frame is meant to float.
	for i := range 50 {
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("line %d", i)})
	}
	m.flush()
	m.OpenSettings(rowProvider)
	next, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	m = pressKeys(m, "esc")
	next, _ = m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	if m.top+m.hModel != 30 {
		t.Fatalf("after overlay cycle: top %d + hModel %d = %d, want 30", m.top, m.hModel, 30)
	}
	if n := len(m.transientBand()); n != m.bandRows() {
		t.Fatalf("band = %d rows, want %d", n, m.bandRows())
	}
}
