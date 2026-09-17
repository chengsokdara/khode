package ui

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"khode/internal/config"
	"khode/internal/llm"

	"github.com/charmbracelet/bubbles/textinput"
)

// newModelListServer serves an OpenAI-style model list and records the
// request, for fetch tests without touching the network.
func newModelListServer(t *testing.T) (*httptest.Server, *string) {
	t.Helper()
	var gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotAuth = r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"data":[{"id":"llama3"},{"id":"qwen"},{"id":"mistral"}]}`)
	}))
	t.Cleanup(srv.Close)
	return srv, &gotAuth
}

func TestCustomProviderEndToEnd(t *testing.T) {
	srv, gotAuth := newModelListServer(t)
	m := newSettingsModel(t)
	m.OpenSettings(rowProvider)

	// Provider list → new custom provider form.
	m = pressKeys(m, "enter")
	if m.settings.view != viewProviderList {
		t.Fatal("enter did not open the provider list")
	}
	m = pressKeys(m, "n")
	if m.settings.form == nil {
		t.Fatal("n did not open the provider form")
	}

	// name, base url (the test server), openai protocol default, save.
	m = pressKeys(m, "ollama", "down", srv.URL, "down", "down")
	next, _ := m.Update(keyMsg("enter"))
	m = next.(Model)

	cp, ok := m.cfg.CustomProviders["ollama"]
	if !ok {
		t.Fatalf("custom provider not saved: %v", m.cfg.CustomProviders)
	}
	if cp.Kind != "openai" || cp.BaseURL != srv.URL {
		t.Errorf("custom provider = %+v", cp)
	}
	// A new provider activates immediately so key/model can be set.
	if m.cfg.Provider != "ollama" {
		t.Fatalf("provider = %q, want ollama (fresh providers activate)", m.cfg.Provider)
	}
	if m.provider.Name() != "ollama" {
		t.Errorf("live provider = %q, want ollama", m.provider.Name())
	}
	if _, err := os.Stat(config.Path()); err != nil {
		t.Error("custom provider not persisted")
	}

	// Its model is unset: chatting is blocked with a pointer at
	// /settings rather than a request for claude-sonnet.
	if m.cfg.Model() != "" {
		t.Fatalf("model = %q, want empty", m.cfg.Model())
	}

	// Model row: customs open the picker, which auto-fetches from the
	// configured endpoint — a real HTTP round trip against the test
	// server, authenticated with the stored key.
	m.auth.SetKey("ollama", "sk-ollama")
	m = pressKeys(m, "esc") // leave the provider list
	m.OpenSettings(rowModel)
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("model picker did not start a fetch")
	}
	msg := cmd().(modelsFetchedMsg)
	if msg.err != nil {
		t.Fatalf("fetch failed: %v", msg.err)
	}
	if *gotAuth != "Bearer sk-ollama" {
		t.Errorf("fetch auth = %q, want Bearer sk-ollama", *gotAuth)
	}
	next, _ = m.Update(msg)
	m = next.(Model)
	if len(m.settings.models.list) != 3 {
		t.Fatalf("picker list = %v", m.settings.models.list)
	}

	// The cursor sits on the first fetched model (nothing is active
	// yet); enter selects it, persists it, and returns to the rows.
	m = pressKeys(m, "enter")
	if got := m.cfg.Model(); got != "llama3" {
		t.Fatalf("model = %q, want llama3 (first fetched)", got)
	}
	if m.settings == nil || m.settings.view != viewRows || m.settings.models != nil {
		t.Errorf("picker did not close after selection: %+v", m.settings)
	}
	data, err := os.ReadFile(config.Path())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "llama3") {
		t.Error("model choice not persisted")
	}
}

func TestModelPickerManualAdd(t *testing.T) {
	// Cached choices present, so the picker opens without a fetch:
	// manual entry must work when an endpoint can't list models.
	m := newSettingsModel(t)
	m.cfg.CustomProviders = map[string]config.CustomProvider{
		"ollama": {Kind: "openai", BaseURL: "http://localhost:11434/v1"},
	}
	m.cfg.SetModelChoices("ollama", []string{"llama3"})
	m.cfg.Provider = "ollama"
	m.rebuildProvider()

	m.OpenSettings(rowModel)
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if cmd != nil {
		t.Error("picker auto-fetched although choices were cached")
	}
	if m.settings.view != viewModels {
		t.Fatal("model picker did not open")
	}

	// n opens the inline add input; typing a name adds it and makes it
	// the active model.
	m = pressKeys(m, "n", "my-finetune", "enter")
	if got := m.cfg.Model(); got != "my-finetune" {
		t.Fatalf("model = %q, want my-finetune", got)
	}
	choices := m.cfg.ModelChoices["ollama"]
	if len(choices) != 2 || choices[1] != "my-finetune" {
		t.Errorf("choices = %v, want llama3 + my-finetune", choices)
	}
	if !m.settings.models.adding && m.settings.view != viewModels {
		t.Error("picker closed after an add; it should stay open")
	}

	// d removes the model under the cursor; removing the active one
	// unsets it and khode falls back to the first remaining choice.
	m = pressKeys(m, "esc")
	m.OpenSettings(rowModel)
	next, _ = m.Update(keyMsg("enter"))
	m = next.(Model)
	m = pressKeys(m, "d")
	if m.cfg.Model() != "llama3" {
		t.Errorf("model after removing the active one = %q, want llama3", m.cfg.Model())
	}
}

// khateway is select-only in the provider list: enter activates it,
// delete is refused, and no edit form ever opens for it.
func TestKhatewaySelectOnlyInProviderList(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenSettings(rowProvider)
	m = pressKeys(m, "enter") // → provider list

	names := m.providerNames()
	khatewayIdx := -1
	for i, n := range names {
		if n == "khateway" {
			khatewayIdx = i
		}
	}
	if khatewayIdx < 0 {
		t.Fatal("khateway missing from the provider list")
	}

	// d refuses deletion…
	for range khatewayIdx {
		m = pressKeys(m, "down")
	}
	m = pressKeys(m, "d")
	if !strings.Contains(m.settings.savedMsg, "can't be removed") {
		t.Errorf("flash = %q, want the built-in removal refusal", m.settings.savedMsg)
	}
	if _, ok := m.cfg.CustomProviders["khateway"]; ok {
		t.Error("khateway ended up in custom providers")
	}

	// …and enter only selects it.
	m = pressKeys(m, "enter")
	if m.cfg.Provider != "khateway" {
		t.Errorf("provider = %q, want khateway", m.cfg.Provider)
	}
	if m.provider.Name() != "khateway" {
		t.Error("provider client not rebuilt")
	}
	if m.settings.form != nil {
		t.Error("an edit form opened for a built-in provider")
	}
}

// The base-url row is read-only for khateway: enter explains the
// KHATEWAY_BASE_URL escape hatch instead of opening the editor, the
// display shows the effective endpoint, and the commit path refuses
// writes even if an editor somehow opens.
func TestKhatewayBaseURLReadOnly(t *testing.T) {
	m := newSettingsModel(t)
	m.switchProvider("khateway")
	m.OpenSettings(rowBaseURL)

	// Default endpoint shown, then the env override wins and is labeled.
	if v := m.settings.value(&m, rowBaseURL); !strings.Contains(v, llm.DefaultKhatewayEndpoint) {
		t.Errorf("base-url value = %q, want the built-in default", v)
	}
	t.Setenv("KHATEWAY_BASE_URL", "https://gw.example.com/v1")
	if v := m.settings.value(&m, rowBaseURL); !strings.Contains(v, "gw.example.com") ||
		!strings.Contains(v, "from KHATEWAY_BASE_URL") {
		t.Errorf("base-url value = %q, want the labeled env override", v)
	}

	// enter must not open the editor.
	m.activateRow()
	if m.settings.editor != nil {
		t.Fatal("base-url editor opened for khateway")
	}
	if !strings.Contains(m.settings.savedMsg, "KHATEWAY_BASE_URL") {
		t.Errorf("flash = %q, want the env-override hint", m.settings.savedMsg)
	}

	// Commit path refuses even with an editor forced open.
	in := textinput.New()
	in.SetValue("http://evil.example")
	m.settings.editor = &textEditor{row: rowBaseURL, input: in}
	m.commitEditor()
	if got := m.cfg.BaseURL("khateway"); got != "" {
		t.Errorf("base url was written anyway: %q", got)
	}
	if !strings.Contains(m.settings.savedMsg, "fixed") {
		t.Errorf("flash = %q, want the fixed-endpoint refusal", m.settings.savedMsg)
	}
}
