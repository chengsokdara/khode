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

	// Provider step: ←/→ moves the cursor, enter switches live.
	m = pressKeys(m, "right", "enter")
	if m.cfg.Provider != "openai" {
		t.Fatalf("provider = %q, want openai after → + enter", m.cfg.Provider)
	}
	if m.provider.Name() != "openai" {
		t.Error("provider client not rebuilt on walkthrough switch")
	}
	if m.welcome.step != welcomeKey {
		t.Fatalf("step = %d, want key after choosing a provider", m.welcome.step)
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

func TestWelcomeCustomProvider(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenWelcome()

	// intro → provider; the list ends with the custom entry:
	// anthropic, openai, custom…  (→ → → lands on it)
	m = pressKeys(m, "enter", "right", "right", "right")
	if m.welcome.step != welcomeProvider {
		t.Fatal("did not reach the provider step")
	}
	if !strings.Contains(m.welcomeView(), "custom") {
		t.Error("provider step does not offer a custom entry")
	}
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeCustom {
		t.Fatal("enter on the custom entry did not open the inline form")
	}

	// Fill the inline form: name, base url, protocol stays openai, save.
	m = pressKeys(m, "ollama", "down", "http://localhost:11434/v1", "down", "down")
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeKey {
		t.Fatalf("saving the custom provider did not reach the key step: %d", m.welcome.step)
	}
	if m.cfg.Provider != "ollama" {
		t.Fatalf("provider = %q, want ollama (fresh customs activate)", m.cfg.Provider)
	}
	if m.provider.Name() != "ollama" {
		t.Error("live provider not rebuilt for the custom provider")
	}
	cp := m.cfg.CustomProviders["ollama"]
	if cp.Kind != "openai" || cp.BaseURL != "http://localhost:11434/v1" {
		t.Errorf("custom provider = %+v", cp)
	}
	if _, err := os.Stat(config.Path()); err != nil {
		t.Error("custom provider not persisted")
	}

	// Key-less endpoints skip the key step with an empty enter.
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeReady {
		t.Fatal("empty key did not advance to the ready card")
	}
	// With no model yet, the ready card must point at the next step.
	if !strings.Contains(m.welcomeView(), "model") {
		t.Error("ready card does not mention picking a model")
	}

	// A fresh walkthrough lists the saved provider, and the inline form
	// rejects a duplicate name.
	m = pressKeys(m, "enter") // close the walkthrough
	m.OpenWelcome()
	// choices: anthropic, openai, ollama, custom… → ×3 lands on custom…
	m = pressKeys(m, "enter", "right", "right", "right", "enter")
	if m.welcome.step != welcomeCustom {
		t.Fatal("did not re-open the custom form")
	}
	m = pressKeys(m, "ollama", "down", "http://x/v1", "down", "down", "enter")
	if m.welcome.step != welcomeCustom {
		t.Error("duplicate provider name was accepted")
	}
	if !strings.Contains(m.welcome.savedMsg, "already exists") {
		t.Errorf("flash = %q, want a duplicate-name error", m.welcome.savedMsg)
	}
}

func TestWelcomeKhatewayHint(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenWelcome()
	m = pressKeys(m, "enter") // intro → provider

	// The provider list now leads with khateway: anthropic, openai,
	// khateway, custom… The khateway row explains what it is.
	if got := m.providerChoices(); len(got) < 4 || got[0] != "anthropic" || got[1] != "openai" || got[2] != "khateway" {
		t.Fatalf("choices = %v, want khateway third", got)
	}
	view := m.welcomeView()
	if !strings.Contains(view, "khateway") || !strings.Contains(view, "router") {
		t.Error("khateway row lacks its explanatory hint")
	}

	// Choosing it stores no vendor default model: the key step comes
	// next, and the model is picked from the fetched list afterwards.
	m = pressKeys(m, "right", "right", "enter")
	if m.welcome.step != welcomeKey {
		t.Fatalf("step = %d, want key after choosing khateway", m.welcome.step)
	}
	if m.cfg.Provider != "khateway" {
		t.Fatalf("provider = %q, want khateway", m.cfg.Provider)
	}
	if m.provider.Name() != "khateway" {
		t.Error("provider client not rebuilt for khateway")
	}
	m = pressKeys(m, "khat-e2e-key", "enter", "enter") // key → ready → close
	if m.welcome != nil {
		t.Error("walkthrough did not close after the ready card")
	}
	if got := m.auth.Key("khateway"); got != "khat-e2e-key" {
		t.Errorf("stored key = %q", got)
	}
	if got := m.cfg.Model(); got != "" {
		t.Errorf("khateway model = %q, want empty until the picker fetches", got)
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
