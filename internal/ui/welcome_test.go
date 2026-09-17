package ui

import (
	"net/http"
	"net/http/httptest"
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

	// Key-less endpoints skip the key step with an empty enter. A custom
	// provider has no model yet, so the next step offers the endpoint's
	// list (the fetch command is discarded here — enter skips ahead).
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeModel {
		t.Fatalf("empty key did not advance to the model step: %d", m.welcome.step)
	}
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeReady {
		t.Fatal("model step enter did not reach the ready card")
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

	// khateway is keyless-native: choosing it skips the key step
	// entirely and lands on the model step (its fetch command is
	// discarded here, so the step sits in the fetching state).
	m = pressKeys(m, "right", "right", "enter")
	if m.cfg.Provider != "khateway" {
		t.Fatalf("provider = %q, want khateway", m.cfg.Provider)
	}
	if m.provider.Name() != "khateway" {
		t.Error("provider client not rebuilt for khateway")
	}
	if m.welcome.step != welcomeModel {
		t.Fatalf("step = %d, want model (no key step for khateway)", m.welcome.step)
	}
	m = pressKeys(m, "enter", "enter") // skip the in-flight fetch → ready → close
	if m.welcome != nil {
		t.Error("walkthrough did not close after the ready card")
	}
	if got := m.auth.Key("khateway"); got != "" {
		t.Errorf("stored key = %q, want none (khateway is keyless)", got)
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

// Choosing khateway in the walkthrough fetches the gateway's model list
// and lets the first-run user pick one on the spot — no /settings
// detour. The fetch rides the khateway openai face (GET <base>/models).
func TestWelcomeKhatewayModelStep(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"object":"list","data":[{"id":"gateway-mini"},{"id":"gateway-max"}]}`))
	}))
	defer srv.Close()

	m := newSettingsModel(t)
	m.cfg.BaseURLs = map[string]string{"khateway": srv.URL}
	m.OpenWelcome()

	// intro → provider → cursor on khateway → choosing it (keyless)
	// lands directly on the model step with a fetch in flight.
	m = pressKeys(m, "enter", "right", "right")
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if m.welcome.step != welcomeModel {
		t.Fatalf("step = %d, want model right after choosing khateway", m.welcome.step)
	}
	if cmd == nil || !m.welcome.fetching {
		t.Fatal("choosing khateway did not start a model-list fetch")
	}

	// Run the fetch command and deliver its result the way the runtime
	// would. The view then lists the gateway's models.
	msg := cmd()
	next, _ = m.Update(msg)
	m = next.(Model)
	if m.welcome.fetching || m.welcome.fetchErr != "" {
		t.Fatalf("fetch did not complete: fetching=%v err=%q", m.welcome.fetching, m.welcome.fetchErr)
	}
	if gotPath != "/models" {
		t.Errorf("fetch hit %q, want /models (the openai face)", gotPath)
	}
	if !strings.Contains(m.welcomeView(), "gateway-mini") || !strings.Contains(m.welcomeView(), "gateway-max") {
		t.Errorf("model step view = %q, want the fetched list", m.welcomeView())
	}

	// Enter picks the cursor's model (the fetch sorts the list, so
	// gateway-max is first) and lands on the ready card, which shows the
	// choice; it is persisted to config.
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeReady {
		t.Fatalf("step = %d, want ready after picking a model", m.welcome.step)
	}
	if got := m.cfg.Model(); got != "gateway-max" {
		t.Errorf("model = %q, want gateway-max", got)
	}
	if !strings.Contains(m.welcomeView(), "gateway-max") {
		t.Error("ready card does not show the picked model")
	}
	if err := m.cfg.Save(); err != nil {
		t.Fatal(err)
	}
	saved, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	if saved.Models["khateway"] != "gateway-max" {
		t.Errorf("persisted khateway model = %q, want gateway-max", saved.Models["khateway"])
	}
}

// A gateway that is down must not wedge the walkthrough: the fetch
// failure renders as a hint and enter continues to the ready card.
func TestWelcomeModelStepFetchFailure(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	srv.Close() // dead port → connection refused

	m := newSettingsModel(t)
	m.cfg.BaseURLs = map[string]string{"khateway": srv.URL}
	m.OpenWelcome()
	m = pressKeys(m, "enter", "right", "right")
	next, cmd := m.Update(keyMsg("enter")) // choose khateway → model step
	m = next.(Model)
	if m.welcome.step != welcomeModel {
		t.Fatalf("step = %d, want model after choosing khateway", m.welcome.step)
	}
	if cmd == nil {
		t.Fatal("no fetch started")
	}
	next, _ = m.Update(cmd())
	m = next.(Model)
	if m.welcome.fetchErr == "" {
		t.Error("fetch failure not surfaced")
	}
	if !strings.Contains(m.welcomeView(), "/settings") {
		t.Error("failure card does not point at /settings")
	}
	m = pressKeys(m, "enter")
	if m.welcome.step != welcomeReady {
		t.Fatalf("step = %d, want ready after continuing past the failure", m.welcome.step)
	}
}
