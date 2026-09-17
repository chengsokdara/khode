package ui

import (
	"os"
	"strings"
	"testing"

	"khode/internal/config"
)

func TestWelcomeFullFlow(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenWelcome()

	// Intro → provider: enter advances, esc never lingers.
	view := m.welcomeView()
	if !strings.Contains(view, "welcome to khode") {
		t.Fatalf("intro view = %q", view)
	}
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeProvider {
		t.Fatalf("step = %d, want provider", m.welcome.step)
	}

	// Provider step: ←/→ switches live and persists.
	m = pressKeys(m, "right")
	if m.cfg.Provider != "openai" {
		t.Fatalf("provider = %q, want openai after →", m.cfg.Provider)
	}
	if m.provider.Name() != "openai" {
		t.Error("provider client not rebuilt on walkthrough switch")
	}

	// Key step: a pasted key is stored per provider, masked on screen.
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeKey {
		t.Fatal("enter did not reach the key step")
	}
	m = pressKeys(m, "sk-openai-test")
	if strings.Contains(m.welcomeView(), "sk-openai-test") {
		t.Error("welcome view shows the raw key")
	}
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeReady {
		t.Fatal("key commit did not reach the ready card")
	}
	if got := m.auth.Key("openai"); got != "sk-openai-test" {
		t.Fatalf("stored key = %q", got)
	}
	if _, err := os.Stat(config.AuthPath()); err != nil {
		t.Error("auth.json not written by the walkthrough")
	}

	// The ready card ends with an explicit exit, and enter takes it.
	if !strings.Contains(m.welcomeView(), "start chatting") {
		t.Error("ready card does not say how to start")
	}
	m = pressKeys(m, "enter")
	if m.welcome != nil {
		t.Error("enter on the ready card did not close the walkthrough")
	}
}

func TestWelcomeSkipAndEmptyKey(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenWelcome()

	// Esc at any step skips the whole walkthrough.
	m = pressKeys(m, "esc")
	if m.welcome != nil {
		t.Fatal("esc did not skip the walkthrough")
	}

	// An empty key is allowed: the walkthrough advances without saving,
	// leaving the pre-flight check in charge.
	m.OpenWelcome()
	m = pressKeys(m, "enter", "enter", "enter")
	if m.welcome.step != welcomeReady {
		t.Fatalf("empty key did not advance: step = %d", m.welcome.step)
	}
	if m.auth.Key(m.cfg.Provider) != "" {
		t.Error("empty key was stored")
	}
}

func TestWelcomeBackNavigation(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenWelcome()
	m = pressKeys(m, "enter", "enter") // intro → provider → key
	if m.welcome.step != welcomeKey {
		t.Fatal("did not reach the key step")
	}
	m = pressKeys(m, "shift+tab")
	if m.welcome.step != welcomeProvider {
		t.Fatal("shift+tab did not go back to the provider step")
	}
}

func TestStatusLineContextMeter(t *testing.T) {
	m := newSettingsModel(t) // anthropic default model, window known

	// No usage yet: no meter.
	if _, _, ok := m.ctxUsage(); ok {
		t.Error("ctx usage reported before any request ran")
	}

	// A fresh conversation is small and below the warning threshold.
	m.ctxIn, m.ctxOut = 10_000, 1_000
	pct, warn, ok := m.ctxUsage()
	if !ok || warn || pct != 5 {
		t.Errorf("10k/200k: pct=%d warn=%v ok=%v, want 5 false true", pct, warn, ok)
	}
	if seg := m.ctxLabel(); !strings.Contains(seg, "ctx 5%") {
		t.Errorf("ctx label = %q, want 5%%", seg)
	}

	// Past the compaction trigger the warning flag flips.
	m.ctxIn, m.ctxOut = 180_000, 5_000
	pct, warn, ok = m.ctxUsage()
	if !ok || !warn || pct != 92 {
		t.Errorf("185k/200k: pct=%d warn=%v ok=%v, want 92 true true", pct, warn, ok)
	}
	if seg := m.ctxLabel(); !strings.Contains(seg, "ctx 92%") {
		t.Errorf("ctx label = %q, want 92%%", seg)
	}

	// The status line carries the segment.
	m.ctxIn, m.ctxOut = 10_000, 1_000
	if line := m.statusLine(); !strings.Contains(line, "ctx") {
		t.Errorf("status line %q missing ctx segment", line)
	}
}
