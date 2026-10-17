package ui

import (
	"os"
	"strings"
	"testing"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/tools"

	tea "charm.land/bubbletea/v2"
)

// keyMsg builds the KeyPressMsg whose String() is s.
func keyMsg(s string) tea.KeyPressMsg {
	switch s {
	case "enter":
		return tea.KeyPressMsg{Code: tea.KeyEnter}
	case "esc":
		return tea.KeyPressMsg{Code: tea.KeyEscape}
	case "up":
		return tea.KeyPressMsg{Code: tea.KeyUp}
	case "down":
		return tea.KeyPressMsg{Code: tea.KeyDown}
	case "tab":
		return tea.KeyPressMsg{Code: tea.KeyTab}
	case "shift+tab":
		return tea.KeyPressMsg{Code: tea.KeyTab, Mod: tea.ModShift}
	case "left":
		return tea.KeyPressMsg{Code: tea.KeyLeft}
	case "right":
		return tea.KeyPressMsg{Code: tea.KeyRight}
	case "backspace":
		return tea.KeyPressMsg{Code: tea.KeyBackspace}
	case "ctrl+u":
		return tea.KeyPressMsg{Code: 'u', Mod: tea.ModCtrl}
	case " ":
		return tea.KeyPressMsg{Code: ' ', Text: " "}
	}
	return tea.KeyPressMsg{Code: []rune(s)[0], Text: s}
}

// pressKeys feeds keys through Update and returns the final model.
func pressKeys(m Model, keys ...string) Model {
	for _, k := range keys {
		next, _ := m.Update(keyMsg(k))
		m = next.(Model)
	}
	return m
}

// newSettingsModel builds a Model with real config persistence under a
// temp HOME and no credentials anywhere (env cleared, no auth file).
func newSettingsModel(t *testing.T) Model {
	t.Helper()
	t.Setenv("HOME", t.TempDir())
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("OPENAI_API_KEY", "")
	cfg, err := config.Load()
	if err != nil {
		t.Fatal(err)
	}
	sess, err := agent.NewSession(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m := New(cfg, &config.Auth{}, nameOnlyProvider{}, sess,
		tools.Default(t.TempDir()), nil, t.TempDir())
	m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	return m
}

func TestSettingsModelCommitPersists(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenSettings(rowModel)

	m = pressKeys(m, "enter")                 // open the model editor
	m = pressKeys(m, "ctrl+u", "gpt-4o-test") // clear the prefill, type
	m = pressKeys(m, "enter")                 // commit

	if got := m.cfg.Model(); got != "gpt-4o-test" {
		t.Fatalf("model = %q, want gpt-4o-test", got)
	}
	if m.settings.editor != nil {
		t.Error("editor still open after commit")
	}
	if !strings.Contains(m.settings.savedMsg, "✓ saved") {
		t.Errorf("no saved flash: %q", m.settings.savedMsg)
	}
	// The commit must reach disk, not just memory.
	data, err := os.ReadFile(config.Path())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "gpt-4o-test") {
		t.Error("config.json on disk missing the new model")
	}
}

func TestSettingsProviderSwitchRebuilds(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenSettings(rowProvider)

	m = pressKeys(m, "right") // anthropic → openai

	if got := m.cfg.Provider; got != "openai" {
		t.Fatalf("provider = %q, want openai", got)
	}
	if got := m.provider.Name(); got != "openai" {
		t.Errorf("live provider = %q, want openai", got)
	}
	// The model falls back to the new provider's own default.
	if got := m.cfg.Model(); got != "gpt-5-mini" {
		t.Errorf("model after switch = %q, want gpt-5-mini", got)
	}
	if _, err := os.Stat(config.Path()); err != nil {
		t.Error("provider switch was not persisted")
	}
}

func TestSettingsAPIKeySaveAndMask(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenSettings(rowAPIKey)

	m = pressKeys(m, "enter") // open the key editor
	m = pressKeys(m, "sk-ant-secret-9999")
	m = pressKeys(m, "enter") // commit

	if got := m.auth.Key("anthropic"); got != "sk-ant-secret-9999" {
		t.Fatalf("stored key = %q", got)
	}
	info, err := os.Stat(config.AuthPath())
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Errorf("auth.json mode = %v, want 0600", info.Mode().Perm())
	}

	// The overlay must never show the full secret.
	view := m.settingsView()
	if strings.Contains(view, "sk-ant-secret-9999") {
		t.Error("full key rendered in the settings view")
	}
	if !strings.Contains(view, "••••9999") {
		t.Error("masked key missing from the settings view")
	}
}

func TestPreflightNoKey(t *testing.T) {
	m := newSettingsModel(t)
	m.textarea.SetValue("hello")
	cmd := m.submit()

	if cmd != nil {
		t.Error("a turn started without credentials")
	}
	if m.streaming {
		t.Error("streaming without credentials")
	}
	found := false
	for _, msg := range m.messages {
		if msg.role == "system" && strings.Contains(msg.raw, "/settings") {
			found = true
		}
	}
	if !found {
		t.Error("no pointer to /settings after a keyless submit")
	}
}

func TestMCPFormCommitAndApply(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenSettings(rowMCP)

	m = pressKeys(m, "enter") // rows → mcp list
	if m.settings.view != viewMCPList {
		t.Fatal("enter did not open the mcp list")
	}
	m = pressKeys(m, "n") // new server form
	if m.settings.form == nil {
		t.Fatal("n did not open the form")
	}

	// name, command, args, env, then down through the enum to save. The
	// final enter is delivered by hand so its reconciliation command can
	// be captured and run.
	m = pressKeys(m, "fs", "down", "echo", "down", "a b", "down", "K=V",
		"down", "down")
	next, cmd := m.Update(keyMsg("enter"))
	m = next.(Model)
	if cmd == nil {
		t.Fatal("saving an mcp server returned no reconciliation command")
	}

	sc, ok := m.cfg.MCPServers["fs"]
	if !ok {
		t.Fatalf("server fs not saved: %v", m.cfg.MCPServers)
	}
	if sc.Command != "echo" {
		t.Errorf("command = %q", sc.Command)
	}
	if len(sc.Args) != 2 || sc.Args[0] != "a" || sc.Args[1] != "b" {
		t.Errorf("args = %v, want [a b]", sc.Args)
	}
	if len(sc.Env) != 1 || sc.Env[0] != "K=V" {
		t.Errorf("env = %v, want [K=V]", sc.Env)
	}
	if sc.Risk != "" {
		t.Errorf("risk = %q, want default (empty)", sc.Risk)
	}
	if m.settings.form != nil {
		t.Error("form still open after save")
	}

	// The returned reconciliation really runs: "echo" is not a JSON-RPC
	// server, so the handshake fails and comes back as a problem.
	msg := cmd().(mcpApplyMsg)
	if len(msg.started) != 0 {
		t.Errorf("echo started as an mcp server: %v", msg.started)
	}
	if len(msg.problems) != 1 {
		t.Errorf("problems = %v, want exactly one", msg.problems)
	}
}

func TestHookFormCommit(t *testing.T) {
	m := newSettingsModel(t)
	m.OpenSettings(rowHooks)

	m = pressKeys(m, "enter", "n") // rows → hook list → new pre_tool form
	// command, tools, down to the type enum, then down to save.
	m = pressKeys(m, "grep secrets", "down", "bash", "down", "down", "enter")

	if len(m.cfg.Hooks.PreTool) != 1 {
		t.Fatalf("pre_tool hooks = %v", m.cfg.Hooks.PreTool)
	}
	h := m.cfg.Hooks.PreTool[0]
	if h.Command != "grep secrets" {
		t.Errorf("command = %q", h.Command)
	}
	if len(h.Tools) != 1 || h.Tools[0] != "bash" {
		t.Errorf("tools = %v, want [bash]", h.Tools)
	}

	// Cycling the type enum to post_tool files the hook in the other
	// list.
	m = pressKeys(m, "n", "echo done", "down", "down", "right", "down", "enter")
	if len(m.cfg.Hooks.PostTool) != 1 {
		t.Fatalf("post_tool hooks = %v", m.cfg.Hooks.PostTool)
	}
	if len(m.cfg.Hooks.PreTool) != 1 {
		t.Errorf("post_tool hook leaked into pre_tool: %v", m.cfg.Hooks.PreTool)
	}
}

func TestSettingsDeleteMCPServer(t *testing.T) {
	m := newSettingsModel(t)
	m.cfg.MCPServers = map[string]config.MCPServer{
		"a": {Command: "x"},
		"b": {Command: "y"},
	}
	m.OpenSettings(rowMCP)
	m = pressKeys(m, "enter") // list open, cursor on "a"

	m = pressKeys(m, "d")
	if _, ok := m.cfg.MCPServers["a"]; ok {
		t.Error("server a not deleted")
	}
	if len(m.cfg.MCPServers) != 1 {
		t.Errorf("servers = %v", m.cfg.MCPServers)
	}
}

// khateway's api-key row offers browser sign-in vs paste (no keyless
// row value any more): enter opens the choice, sign-in opens the
// device dialog above the overlay, esc returns, paste opens the editor.
func TestSettingsKhatewayKeyChoice(t *testing.T) {
	m := newSettingsModel(t)
	m.cfg.Provider = "khateway"
	m.OpenSettings(rowAPIKey)

	m = pressKeys(m, "enter")
	if m.settings.view != viewKeyChoice {
		t.Fatalf("view = %v, want the khateway key choice", m.settings.view)
	}
	view := m.settingsView()
	if !strings.Contains(view, "sign in with your browser") || !strings.Contains(view, "paste an API key") {
		t.Errorf("choice view = %q, want both options", view)
	}

	// enter on sign-in opens the device dialog; esc returns to the choice.
	m = pressKeys(m, "enter")
	if m.deviceLogin == nil {
		t.Fatal("sign-in choice did not open the device dialog")
	}
	m = pressKeys(m, "esc")
	if m.deviceLogin != nil {
		t.Fatal("esc did not close the device dialog")
	}
	if m.settings == nil || m.settings.view != viewKeyChoice {
		t.Fatalf("settings after dialog esc = %v, want the key choice", m.settings)
	}

	// esc leaves the choice; re-entering and choosing paste opens the
	// editor, and a committed key is stored for khateway.
	m = pressKeys(m, "esc")
	if m.settings.view != viewRows {
		t.Fatalf("view = %v, want rows after esc", m.settings.view)
	}
	m = pressKeys(m, "enter", "down", "enter")
	if m.settings.editor == nil {
		t.Fatal("paste choice did not open the key editor")
	}
	m = pressKeys(m, "khat-paste-9", "enter")
	if got := m.auth.Key("khateway"); got != "khat-paste-9" {
		t.Errorf("stored khateway key = %q, want khat-paste-9", got)
	}
}
