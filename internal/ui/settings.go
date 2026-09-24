package ui

// The /settings overlay: every config.json value plus the auth.json API
// keys, editable in place. Rows save the moment they commit — there is
// no staged "apply" step — mirroring how /mode and /model already
// persist. Keys route here whenever Model.settings is non-nil.

import (
	"context"
	"fmt"
	"maps"
	"os"
	"sort"
	"strconv"
	"strings"

	"khode/internal/config"
	"khode/internal/llm"
	"khode/internal/mcp"
	"khode/internal/perm"
	"khode/internal/tools"

	"charm.land/bubbles/v2/textinput"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// settingsRow enumerates the top-level rows.
type settingsRow int

const (
	rowProvider settingsRow = iota
	rowAPIKey
	rowBaseURL
	rowModel
	rowMaxTokens
	rowMode
	rowMCP
	rowHooks
	rowSentinel // keep last
)

// settingsView identifies which layer of the overlay is on screen.
type settingsView int

const (
	viewRows         settingsView = iota // top-level rows
	viewProviderList                     // providers: built-ins + custom
	viewModels                           // model picker for the active provider
	viewMCPList                          // configured MCP servers
	viewHookList                         // configured hooks
	viewKeyChoice                        // khateway access: browser sign-in vs paste
)

// formKind distinguishes the forms that manage lists of things.
type formKind int

const (
	formMCPServer formKind = iota
	formHook
	formProvider
)

// riskChoices are the per-server MCP tool risk overrides in cycle order;
// empty means the safe default (exec).
var riskChoices = []string{"", "read", "write"}

// settings holds the overlay state; Model.settings is non-nil while it
// is open.
type settings struct {
	cursor  int // top-level row under the cursor
	view    settingsView
	listCur int // cursor within the open sub-list

	editor   *textEditor  // open single-line editor, nil when closed
	form     *serverForm  // open mcp/hook/provider form, nil when closed
	models   *modelPicker // model picker for the active provider
	savedMsg string       // last "✓ saved …" flash, shown in the footer
}

// textEditor is one open single-line value editor (key, url, model,
// token budget).
type textEditor struct {
	row   settingsRow
	input textinput.Model
	hint  string // what enter will do, shown in the footer
}

// serverForm edits one MCP server or one hook: single-line inputs for
// the text fields, then an enum row (risk / hook type) and a save row.
type serverForm struct {
	kind     formKind
	origName string // mcp: map key of the entry being edited ("" = new)
	origPre  bool   // hook: the entry being edited is a pre_tool hook
	origIdx  int    // hook: its index in that list, -1 when new
	inputs   []textinput.Model
	field    int // focused row; len(inputs) = enum row, +1 = save row
	enum     int // index into the form's enum choices
}

// OpenSettings opens the overlay, focused on the given row.
func (m *Model) OpenSettings(row settingsRow) {
	m.settings = &settings{cursor: int(row)}
}

// --- key handling ------------------------------------------------------------

// settingsKey handles input while the overlay is open. Precedence:
// open editor, open form, sub-list, top-level rows.
func (m *Model) settingsKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings
	if msg.String() == "ctrl+c" {
		m.stopStream()
		return tea.Quit
	}

	if s.editor != nil {
		switch msg.String() {
		case "enter":
			return m.commitEditor()
		case "esc":
			s.editor = nil
		default:
			var cmd tea.Cmd
			s.editor.input, cmd = s.editor.input.Update(msg)
			return cmd
		}
		return nil
	}

	if s.form != nil {
		cmd, flash, closed := m.formKey(msg, s.form)
		if flash != "" {
			s.savedMsg = flash
		}
		if closed {
			s.form = nil
		}
		return cmd
	}

	switch s.view {
	case viewProviderList:
		return m.providerListKey(msg)
	case viewModels:
		return m.modelPickerKey(msg)
	case viewMCPList:
		return m.mcpListKey(msg)
	case viewHookList:
		return m.hookListKey(msg)
	case viewKeyChoice:
		return m.keyChoiceKey(msg)
	}

	switch msg.String() {
	case "up", "k", "ctrl+p":
		if s.cursor > 0 {
			s.cursor--
		}
	case "down", "j", "ctrl+n":
		if s.cursor < int(rowSentinel)-1 {
			s.cursor++
		}
	case "left", "h":
		m.cycleSetting(-1)
	case "right", "l":
		m.cycleSetting(1)
	case "enter":
		return m.activateRow()
	case "esc":
		m.settings = nil
	}
	return nil
}

// activateRow opens whatever the enter key promises for the cursor row:
// an editor, a sub-list, or the next enum value.
func (m *Model) activateRow() tea.Cmd {
	s := m.settings
	switch settingsRow(s.cursor) {
	case rowProvider:
		s.view = viewProviderList
		s.listCur = 0
	case rowMode:
		m.cycleSetting(1)
	case rowAPIKey:
		if strings.EqualFold(m.cfg.Provider, llm.ProviderKhateway) {
			// khateway needs a credential: offer browser sign-in next
			// to the plain paste editor.
			s.view = viewKeyChoice
			s.listCur = 0
			break
		}
		m.openEditor(rowAPIKey)
	case rowBaseURL:
		if config.ManagedEndpoint(m.cfg.Provider) {
			s.savedMsg = m.cfg.Provider + "'s endpoint is fixed · set " +
				m.cfg.BaseURLEnvName(m.cfg.Provider) + " to point elsewhere"
			break
		}
		m.openEditor(rowBaseURL)
	case rowModel:
		return m.openModelRow()
	case rowMaxTokens:
		m.openEditor(rowMaxTokens)
	case rowMCP:
		s.view = viewMCPList
		s.listCur = 0
	case rowHooks:
		s.view = viewHookList
		s.listCur = 0
	}
	return nil
}

// keyChoiceKey handles the khateway access choice (browser device
// sign-in vs the paste editor). esc returns to the rows; the sign-in
// dialog opens above the overlay and returns here when it closes.
func (m *Model) keyChoiceKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings
	switch msg.String() {
	case "up", "k", "ctrl+p", "left", "h":
		if s.listCur > 0 {
			s.listCur--
		}
	case "down", "j", "ctrl+n", "right", "l":
		if s.listCur < 1 {
			s.listCur++
		}
	case "enter":
		switch s.listCur {
		case 0:
			return m.openDeviceLogin()
		case 1:
			s.view = viewRows
			m.openEditor(rowAPIKey)
		}
	case "esc", "shift+tab":
		s.view = viewRows
	}
	return nil
}

// keyChoiceView renders the khateway access choice rows.
func (m *Model) keyChoiceView() []string {
	cur := m.settings.listCur
	choices := []struct{ main, sub string }{
		{"sign in with your browser", "device flow · recommended"},
		{"paste an API key", "from the gateway portal's Keys page"},
	}
	out := make([]string, 0, len(choices))
	for i, ch := range choices {
		line := ch.main + dimStyle.Render("  "+ch.sub)
		if i == cur {
			out = append(out, pickSel.Render("❯ "+line))
		} else {
			out = append(out, "  "+line)
		}
	}
	return out
}

// cycleSetting applies ←/→ on the enum rows: provider and mode.
func (m *Model) cycleSetting(dir int) {
	s := m.settings
	switch settingsRow(s.cursor) {
	case rowProvider:
		names := m.providerNames()
		idx := 0
		for i, n := range names {
			if n == m.cfg.Provider {
				idx = i
			}
		}
		m.switchProvider(names[(idx+dir+len(names))%len(names)])
	case rowMode:
		modes := perm.Modes()
		idx := 0
		for i, mo := range modes {
			if mo == m.mode() {
				idx = i
			}
		}
		m.applyMode(modes[(idx+dir+len(modes))%len(modes)])
	}
}

// --- saving ------------------------------------------------------------------

// saveSettings persists the config and flashes the fact. The flash goes
// to whichever overlay is open — the welcome walkthrough also switches
// providers, so settings may be nil. Key changes save through
// auth.Save instead.
func (m *Model) saveSettings(what string) {
	if !m.saveConfig() {
		return
	}
	flash := "✓ saved " + what
	if m.settings != nil {
		m.settings.savedMsg = flash
	}
	if m.welcome != nil {
		m.welcome.savedMsg = flash
	}
}

// saveConfig persists config.json, reporting whether it worked; a
// failure is recorded in lastErr for the next status-line slot.
func (m *Model) saveConfig() bool {
	if err := m.cfg.Save(); err != nil {
		m.lastErr = err.Error()
		return false
	}
	return true
}

// switchProvider persists a provider change and rebuilds the client, so
// the next turn and future subagents use it. In-flight turns keep the
// old client. Both /settings and the welcome walkthrough switch through
// here.
func (m *Model) switchProvider(name string) {
	m.cfg.Provider = name
	m.rebuildProvider()
	m.saveSettings("provider → " + name + " · model " + m.cfg.Model())
}

// applyMode switches the permission mode from the overlay: the same
// persistence setMode does, with the flash as feedback instead of a chat
// notice (cycling would otherwise spam the transcript).
func (m *Model) applyMode(want perm.Mode) {
	m.cfg.PermissionMode = string(want)
	m.saveSettings("mode → " + string(want))
}

// rebuildProvider re-creates the active provider client from the current
// config and auth state: built-ins speak their own protocol, custom
// providers the protocol they declare. The task tool is re-registered
// because its config captured the provider by value.
func (m *Model) rebuildProvider() {
	key, baseURL := m.cfg.Credentials(m.auth, m.cfg.Provider)
	p, err := llm.NewProtocol(m.cfg.ProviderProtocol(m.cfg.Provider), m.cfg.Provider, key, baseURL)
	if err != nil {
		m.lastErr = err.Error() // unreachable: row values are validated names
		return
	}
	m.provider = p
	m.registerTaskTool()
}

// --- text editors ------------------------------------------------------------

// openEditor opens the single-line editor for one row, prefilled where
// the value is not a secret. The API key is never prefilled: an empty
// field plus enter removes it.
func (m *Model) openEditor(row settingsRow) {
	in := textinput.New()
	in.Prompt = ""
	in.SetWidth(52)
	var hint string
	switch row {
	case rowAPIKey:
		in.EchoMode = textinput.EchoPassword
		in.EchoCharacter = '•'
		in.Placeholder = "paste key · enter save · leave empty to remove"
		hint = "stored in ~/.khode/auth.json (owner-only)"
	case rowBaseURL:
		in.SetValue(m.cfg.BaseURL(m.cfg.Provider))
		in.Placeholder = "(default endpoint)"
		hint = "empty restores the default endpoint"
	case rowModel:
		in.SetValue(m.cfg.Model())
		hint = "enter switches model"
	case rowMaxTokens:
		in.SetValue(strconv.Itoa(m.cfg.MaxTokens))
		hint = "enter saves the token budget"
	}
	in.Focus()
	m.settings.editor = &textEditor{row: row, input: in, hint: hint}
}

// commitEditor applies and persists the edited value.
func (m *Model) commitEditor() tea.Cmd {
	s := m.settings
	row := s.editor.row
	val := strings.TrimSpace(s.editor.input.Value())
	s.editor = nil
	switch row {
	case rowAPIKey:
		m.auth.SetKey(m.cfg.Provider, val)
		if err := m.auth.Save(); err != nil {
			m.lastErr = err.Error()
			return nil
		}
		m.rebuildProvider()
		if val == "" {
			s.savedMsg = "✓ key removed"
		} else {
			s.savedMsg = "✓ key saved " + maskKey(val)
		}
	case rowBaseURL:
		// Defense in depth: the editor never opens for managed
		// endpoints, so a commit here would only happen through a bug.
		if config.ManagedEndpoint(m.cfg.Provider) {
			s.savedMsg = "✗ " + m.cfg.Provider + "'s endpoint is fixed · use " +
				m.cfg.BaseURLEnvName(m.cfg.Provider) + " to override"
			break
		}
		if val == "" {
			delete(m.cfg.BaseURLs, m.cfg.Provider)
			m.rebuildProvider()
			m.saveSettings("base url → default")
			break
		}
		if m.cfg.BaseURLs == nil {
			m.cfg.BaseURLs = map[string]string{}
		}
		m.cfg.BaseURLs[m.cfg.Provider] = val
		m.rebuildProvider()
		m.saveSettings("base url → " + clip(val, 30))
	case rowModel:
		if val == "" {
			s.savedMsg = "model unchanged"
			break
		}
		m.cfg.SetModel(val)
		m.saveSettings("model → " + m.cfg.Model())
	case rowMaxTokens:
		n, err := strconv.Atoi(val)
		if err != nil || n <= 0 {
			s.savedMsg = "✗ max tokens must be a positive number"
			break
		}
		m.cfg.MaxTokens = n
		m.saveSettings("max tokens → " + strconv.Itoa(n))
	}
	return nil
}

// --- mcp server list ---------------------------------------------------------

func (m *Model) mcpListKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings
	names := sortedServerNames(m.cfg.MCPServers)
	switch msg.String() {
	case "up", "k", "ctrl+p":
		if s.listCur > 0 {
			s.listCur--
		}
	case "down", "j", "ctrl+n":
		if s.listCur < len(names)-1 {
			s.listCur++
		}
	case "n":
		m.openMCPForm("")
	case "d":
		if len(names) == 0 {
			break
		}
		i := min(s.listCur, len(names)-1)
		name := names[i]
		delete(m.cfg.MCPServers, name)
		s.listCur = max(0, i-1)
		m.saveSettings("mcp server " + name + " removed")
		return m.applyMCPCmd(nil)
	case "enter":
		if len(names) == 0 {
			break
		}
		m.openMCPForm(names[min(s.listCur, len(names)-1)])
	case "esc":
		s.view = viewRows
	}
	return nil
}

// openMCPForm edits the named server, or a new one when name is "".
func (m *Model) openMCPForm(name string) {
	m.settings.form = m.newMCPServerForm(name)
	m.settings.form.focus()
}

// newMCPServerForm builds the add/edit form for one MCP server: name,
// command, args, env, and the risk enum. An empty name is a new server.
func (m *Model) newMCPServerForm(name string) *serverForm {
	sc := m.cfg.MCPServers[name] // zero value when new
	inputs := make([]textinput.Model, 4)
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Prompt = ""
		inputs[i].SetWidth(52)
	}
	inputs[0].SetValue(name)
	inputs[0].Placeholder = "unique name"
	inputs[1].SetValue(sc.Command)
	inputs[1].Placeholder = "command to run"
	inputs[2].SetValue(strings.Join(sc.Args, " "))
	inputs[2].Placeholder = "arguments, space-separated"
	inputs[3].SetValue(strings.Join(sc.Env, " "))
	inputs[3].Placeholder = "KEY=VALUE, space-separated"
	enum := 0
	for i, r := range riskChoices {
		if r == sc.Risk {
			enum = i
		}
	}
	return &serverForm{kind: formMCPServer, origName: name, inputs: inputs, enum: enum}
}

// --- hook list ---------------------------------------------------------------

// hookEntry flattens the two hook lists into one navigable order: all
// pre_tool hooks, then all post_tool hooks.
type hookEntry struct {
	pre bool
	idx int
}

func (m *Model) hookEntries() []hookEntry {
	var out []hookEntry
	for i := range m.cfg.Hooks.PreTool {
		out = append(out, hookEntry{true, i})
	}
	for i := range m.cfg.Hooks.PostTool {
		out = append(out, hookEntry{false, i})
	}
	return out
}

func (m *Model) hookAt(e hookEntry) config.Hook {
	if e.pre {
		return m.cfg.Hooks.PreTool[e.idx]
	}
	return m.cfg.Hooks.PostTool[e.idx]
}

func (m *Model) hookListKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings
	entries := m.hookEntries()
	switch msg.String() {
	case "up", "k", "ctrl+p":
		if s.listCur > 0 {
			s.listCur--
		}
	case "down", "j", "ctrl+n":
		if s.listCur < len(entries)-1 {
			s.listCur++
		}
	case "n":
		m.openHookForm(true, -1)
	case "d":
		if len(entries) == 0 {
			break
		}
		i := min(s.listCur, len(entries)-1)
		e := entries[i]
		kind := "post_tool"
		if e.pre {
			kind = "pre_tool"
		}
		if e.pre {
			m.cfg.Hooks.PreTool = append(m.cfg.Hooks.PreTool[:e.idx], m.cfg.Hooks.PreTool[e.idx+1:]...)
		} else {
			m.cfg.Hooks.PostTool = append(m.cfg.Hooks.PostTool[:e.idx], m.cfg.Hooks.PostTool[e.idx+1:]...)
		}
		s.listCur = max(0, i-1)
		m.saveSettings(kind + " hook removed · applies next turn")
	case "enter":
		if len(entries) == 0 {
			break
		}
		e := entries[min(s.listCur, len(entries)-1)]
		m.openHookForm(e.pre, e.idx)
	case "esc":
		s.view = viewRows
	}
	return nil
}

// openHookForm edits the given hook, or a new pre_tool hook when idx is
// -1.
func (m *Model) openHookForm(pre bool, idx int) {
	var h config.Hook
	if idx >= 0 {
		h = m.hookAt(hookEntry{pre, idx})
	}
	inputs := make([]textinput.Model, 2)
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Prompt = ""
		inputs[i].SetWidth(52)
	}
	inputs[0].SetValue(h.Command)
	inputs[0].Placeholder = "shell command (tool call JSON on stdin)"
	inputs[1].SetValue(strings.Join(h.Tools, " "))
	inputs[1].Placeholder = "tool filter · empty = every tool"
	enum := 1 // post_tool
	if pre {
		enum = 0
	}
	m.settings.form = &serverForm{kind: formHook, origPre: pre, origIdx: idx, inputs: inputs, enum: enum}
	m.settings.form.focus()
}

// --- forms -------------------------------------------------------------------

// focus moves the input focus to the form's current field.
func (f *serverForm) focus() {
	for i := range f.inputs {
		f.inputs[i].Blur()
	}
	if f.field < len(f.inputs) {
		f.inputs[f.field].Focus()
	}
}

// cycleEnum steps the enum row with wrap-around.
func (f *serverForm) cycleEnum(dir int) {
	n := 2 // hook type: pre/post
	if f.kind == formMCPServer {
		n = len(riskChoices)
	}
	f.enum = ((f.enum+dir)%n + n) % n
}

// formKey handles one key for an open form. It reports closed=true when
// the form should close (esc or a successful commit) and flash carries
// the outcome for the hosting surface to show (settings footer, /mcp
// dialog).
func (m *Model) formKey(msg tea.KeyMsg, f *serverForm) (cmd tea.Cmd, flash string, closed bool) {
	key := msg.String()

	// The save row: enter commits, up walks back.
	if f.field == len(f.inputs)+1 {
		switch key {
		case "enter", "space":
			return m.commitForm(f)
		case "up", "k", "ctrl+p":
			f.field--
		case "esc":
			return nil, "", true
		}
		return nil, "", false
	}

	// The enum row: ←/→/enter cycle.
	if f.field == len(f.inputs) {
		switch key {
		case "left", "h":
			f.cycleEnum(-1)
		case "right", "l", "enter", "space":
			f.cycleEnum(1)
		case "up", "k", "ctrl+p":
			f.field--
			f.focus()
		case "down", "tab", "ctrl+n":
			f.field++
		case "esc":
			return nil, "", true
		}
		return nil, "", false
	}

	// Text rows: navigation keys move between fields; everything else
	// reaches the focused input.
	switch key {
	case "esc":
		return nil, "", true
	case "up", "k", "ctrl+p":
		if f.field > 0 {
			f.field--
			f.focus()
		}
		return nil, "", false
	case "down", "tab", "ctrl+n", "enter":
		f.field++
		f.focus()
		return nil, "", false
	}
	var inputCmd tea.Cmd
	f.inputs[f.field], inputCmd = f.inputs[f.field].Update(msg)
	return inputCmd, "", false
}

// commitForm validates and saves the open form. It returns the outcome
// flash, closed=true when the form should close, and the reconcile cmd —
// a saved MCP server kicks off the reconciliation that starts (or
// restarts) it live.
func (m *Model) commitForm(f *serverForm) (cmd tea.Cmd, flash string, closed bool) {
	switch f.kind {
	case formMCPServer:
		name := strings.TrimSpace(f.inputs[0].Value())
		command := strings.TrimSpace(f.inputs[1].Value())
		if name == "" || command == "" {
			return nil, "✗ name and command are required", false
		}
		if name != f.origName {
			if _, exists := m.cfg.MCPServers[name]; exists {
				return nil, "✗ a server named " + name + " already exists", false
			}
			delete(m.cfg.MCPServers, f.origName)
		}
		if m.cfg.MCPServers == nil {
			m.cfg.MCPServers = map[string]config.MCPServer{}
		}
		m.cfg.MCPServers[name] = config.MCPServer{
			Command: command,
			Args:    strings.Fields(f.inputs[2].Value()),
			Env:     strings.Fields(f.inputs[3].Value()),
			Risk:    riskChoices[f.enum],
		}
		// An edit to a running server must restart it for the new
		// command/env/risk to take effect.
		var restart []string
		if _, running := m.mcpClients[name]; running {
			restart = []string{name}
		}
		if !m.saveConfig() {
			return m.applyMCPCmd(restart), "✗ saving config failed", true
		}
		return m.applyMCPCmd(restart), "✓ saved mcp server " + name, true

	case formHook:
		command := strings.TrimSpace(f.inputs[0].Value())
		if command == "" {
			return nil, "✗ a hook needs a command", false
		}
		h := config.Hook{Command: command, Tools: strings.Fields(f.inputs[1].Value())}
		if f.origIdx >= 0 {
			if f.origPre {
				m.cfg.Hooks.PreTool = append(m.cfg.Hooks.PreTool[:f.origIdx], m.cfg.Hooks.PreTool[f.origIdx+1:]...)
			} else {
				m.cfg.Hooks.PostTool = append(m.cfg.Hooks.PostTool[:f.origIdx], m.cfg.Hooks.PostTool[f.origIdx+1:]...)
			}
		}
		if f.enum == 0 {
			m.cfg.Hooks.PreTool = append(m.cfg.Hooks.PreTool, h)
		} else {
			m.cfg.Hooks.PostTool = append(m.cfg.Hooks.PostTool, h)
		}
		// A fresh hooks.Runner is built per turn from cfg.Hooks, so the
		// change is live without further plumbing.
		if !m.saveConfig() {
			return nil, "✗ saving config failed", true
		}
		return nil, "✓ saved hook · applies next turn", true

	case formProvider:
		name := strings.TrimSpace(f.inputs[0].Value())
		baseURL := strings.TrimSpace(f.inputs[1].Value())
		kind := "openai"
		if f.enum == 1 {
			kind = "anthropic"
		}
		if name == "" || baseURL == "" {
			return nil, "✗ name and base url are required", false
		}
		if name != f.origName && m.providerNameTaken(name, f.origName) {
			return nil, "✗ a provider named " + name + " already exists", false
		}
		if m.cfg.CustomProviders == nil {
			m.cfg.CustomProviders = map[string]config.CustomProvider{}
		}
		delete(m.cfg.CustomProviders, f.origName)
		m.cfg.CustomProviders[name] = config.CustomProvider{Kind: kind, BaseURL: baseURL}
		// Renaming drags the cached model list and the active pointer
		// along, so the provider stays exactly as configured.
		if name != f.origName {
			if choices := m.cfg.ModelChoices[f.origName]; len(choices) > 0 {
				m.cfg.SetModelChoices(name, choices)
				m.cfg.SetModelChoices(f.origName, nil)
			}
			if m.cfg.Provider == f.origName {
				m.cfg.Provider = name
			}
		}
		fresh := f.origName == ""
		// A new provider becomes active immediately so its api key and
		// model can be set without hunting for it; an edit to the
		// active provider re-authenticates with the new endpoint. The
		// form stays open either way, like the settings flow it serves.
		if fresh || m.cfg.Provider == name {
			m.switchProvider(name)
			if fresh {
				return nil, "✓ provider " + name + " activated · set its api key and model", false
			}
			return nil, "", false
		}
		if !m.saveConfig() {
			return nil, "✗ saving config failed", false
		}
		return nil, "✓ saved provider " + name + " (" + kind + ")", false
	}
	return nil, "", false
}

// --- live MCP reconciliation ---------------------------------------------------

// mcpApplyMsg reports one reconciliation of the running MCP server set
// with the configured one.
type mcpApplyMsg struct {
	started  map[string]*mcp.Client
	removed  []string
	problems []string
}

// applyMCPCmd brings the running servers in line with cfg.MCPServers:
// stops servers that are gone, starts ones that are new, and force-
// restarts the named ones (an edit while running). It runs off the UI
// goroutine because an initialize handshake can take seconds; it works
// from snapshots so it never touches Model-owned maps mid-flight, and
// the registry's lock makes the tool add/remove safe against a
// concurrently reading agent loop.
func (m *Model) applyMCPCmd(restart []string) tea.Cmd {
	servers := maps.Clone(m.cfg.MCPServers)
	if servers == nil {
		servers = map[string]config.MCPServer{}
	}
	running := maps.Clone(m.mcpClients)
	if running == nil {
		running = map[string]*mcp.Client{}
	}
	return func() tea.Msg {
		var msg mcpApplyMsg
		for _, name := range restart {
			if cli, ok := running[name]; ok {
				cli.Close()
				tools.RemoveMCP(m.tools, name)
				delete(running, name)
			}
		}
		for name, cli := range running {
			if _, ok := servers[name]; !ok {
				cli.Close()
				tools.RemoveMCP(m.tools, name)
				msg.removed = append(msg.removed, name)
			}
		}
		sort.Strings(msg.removed)
		for _, name := range sortedServerNames(servers) {
			if _, ok := running[name]; ok {
				continue
			}
			sc := servers[name]
			ctx, cancel := context.WithTimeout(context.Background(), mcp.InitTimeout)
			cli, err := mcp.Start(ctx, name, sc.Command, sc.Args, sc.Env)
			cancel()
			if err != nil {
				msg.problems = append(msg.problems, fmt.Sprintf("%s unavailable: %v", name, err))
				continue
			}
			if err := tools.AddMCP(m.tools, name, cli, sc.Risk); err != nil {
				cli.Close()
				msg.problems = append(msg.problems, fmt.Sprintf("%s has no tools: %v", name, err))
				continue
			}
			if msg.started == nil {
				msg.started = map[string]*mcp.Client{}
			}
			msg.started[name] = cli
		}
		return msg
	}
}

// applyMCPResult records a finished reconciliation: it moves the new
// clients into the UI-owned map and reports the outcome in chat (the
// overlay may have been closed while the handshake ran).
func (m *Model) applyMCPResult(msg mcpApplyMsg) {
	if p := m.mcpPanel; p != nil {
		p.busy = nil // every reconcile the /mcp dialog kicked has settled
	}
	for _, name := range msg.removed {
		delete(m.mcpClients, name)
	}
	for name, cli := range msg.started {
		m.mcpClients[name] = cli
	}
	var notes []string
	if len(msg.removed) > 0 {
		notes = append(notes, "stopped "+strings.Join(msg.removed, ", "))
	}
	names := make([]string, 0, len(msg.started))
	for name := range msg.started {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		prefix := "mcp__" + name + "__"
		count := 0
		for _, tn := range m.tools.Names() {
			if strings.HasPrefix(tn, prefix) {
				count++
			}
		}
		notes = append(notes, fmt.Sprintf("started %s (%d tools)", name, count))
	}
	for _, p := range msg.problems {
		notes = append(notes, "✗ "+p)
	}
	if len(notes) == 0 {
		return
	}
	if m.settings != nil {
		m.settings.savedMsg = strings.Join(notes, " · ")
	}
	m.messages = append(m.messages, uiMessage{role: "system", raw: "mcp: " + strings.Join(notes, " · ")})
}

// --- views -------------------------------------------------------------------

func (m *Model) settingsView() string {
	s := m.settings
	title := dialogTitle("settings", "changes save instantly")
	var body []string
	switch {
	case s.form != nil:
		body = serverFormView(s.form)
	case s.view == viewProviderList:
		title = dialogTitle("settings · providers", "n new custom · enter switch/edit · d remove")
		body = m.providerListView()
	case s.view == viewModels:
		title = dialogTitle("settings · models", "for "+m.cfg.Provider)
		body = m.modelPickerView()
	case s.view == viewMCPList:
		title = dialogTitle("settings · mcp servers", "n new · enter edit · d remove")
		body = m.mcpListView()
	case s.view == viewHookList:
		title = dialogTitle("settings · hooks", "n new · enter edit · d remove")
		body = m.hookListView()
	case s.view == viewKeyChoice:
		title = dialogTitle("settings · khateway access", "sign in with a browser or paste a key")
		body = m.keyChoiceView()
	default:
		body = s.rowsView(m)
	}

	var footer string
	switch {
	case s.savedMsg != "":
		footer = flash(s.savedMsg)
	case s.editor != nil:
		footer = keyHint("enter", "save") + dimStyle.Render("  ·  ") +
			keyHint("esc", "cancel") + dimStyle.Render("  ·  "+s.editor.hint)
	default:
		footer = keyHint("↑/↓", "move") + dimStyle.Render("  ·  ") +
			keyHint("←/→", "change") + dimStyle.Render("  ·  ") +
			keyHint("enter", "edit") + dimStyle.Render("  ·  ") +
			keyHint("esc", "close")
	}

	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left,
		title, "", strings.Join(body, "\n"), "", footer))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}

func (s *settings) rowsView(m *Model) []string {
	rows := make([]string, 0, int(rowSentinel))
	for i := 0; i < int(rowSentinel); i++ {
		rows = append(rows, s.renderRow(m, settingsRow(i)))
	}
	return rows
}

func (s *settings) renderRow(m *Model, row settingsRow) string {
	editing := s.editor != nil && s.editor.row == row
	marker := "  "
	if editing || (row == settingsRow(s.cursor) && s.view == viewRows && s.editor == nil) {
		marker = pickSel.Render("❯ ")
	}
	label := dimStyle.Render(fmt.Sprintf("%-13s", rowLabel(row)+":"))
	if editing {
		return marker + label + s.editor.input.View()
	}
	return marker + label + s.value(m, row)
}

func rowLabel(row settingsRow) string {
	switch row {
	case rowProvider:
		return "provider"
	case rowAPIKey:
		return "api key"
	case rowBaseURL:
		return "base url"
	case rowModel:
		return "model"
	case rowMaxTokens:
		return "max tokens"
	case rowMode:
		return "mode"
	case rowMCP:
		return "mcp servers"
	case rowHooks:
		return "hooks"
	}
	return ""
}

func (s *settings) value(m *Model, row settingsRow) string {
	switch row {
	case rowProvider:
		return m.cfg.Provider + dimStyle.Render("  ←/→ switch · enter manage")
	case rowAPIKey:
		return m.apiKeyValue()
	case rowBaseURL:
		if config.ManagedEndpoint(m.cfg.Provider) {
			envName := m.cfg.BaseURLEnvName(m.cfg.Provider)
			u := os.Getenv(envName)
			note := "from " + envName
			if u == "" {
				u = m.cfg.BaseURL(m.cfg.Provider)
				note = "from config"
			}
			if u == "" {
				u = llm.DefaultKhatewayEndpoint
				note = "fixed · " + envName + " to override"
			}
			return clip(u, 44) + dimStyle.Render("  "+note)
		}
		if u := m.cfg.BaseURL(m.cfg.Provider); u != "" {
			return clip(u, 44)
		}
		return dimStyle.Render("(default endpoint)")
	case rowModel:
		if mo := m.cfg.Model(); mo != "" {
			return mo
		}
		return dimStyle.Render("not set · enter to pick")
	case rowMaxTokens:
		return strconv.Itoa(m.cfg.MaxTokens)
	case rowMode:
		return string(m.mode()) + dimStyle.Render("  "+modeDescription(m.mode()))
	case rowMCP:
		if n := len(m.cfg.MCPServers); n > 0 {
			return fmt.Sprintf("%d · %s", n, strings.Join(sortedServerNames(m.cfg.MCPServers), ", "))
		}
		return dimStyle.Render("none · enter to add")
	case rowHooks:
		p, q := len(m.cfg.Hooks.PreTool), len(m.cfg.Hooks.PostTool)
		if p+q > 0 {
			return fmt.Sprintf("%d pre · %d post", p, q)
		}
		return dimStyle.Render("none · enter to add")
	}
	return ""
}

// apiKeyValue renders the key row: masked, with its source — the full
// secret is never displayed. khateway without a key points at the
// sign-in-or-paste choice instead of a bare "not set".
func (m *Model) apiKeyValue() string {
	stored := m.auth.Key(m.cfg.Provider)
	if env := os.Getenv(m.cfg.APIKeyEnvName(m.cfg.Provider)); env != "" {
		return maskKey(env) + dimStyle.Render("  from "+m.cfg.APIKeyEnvName(m.cfg.Provider))
	}
	if stored != "" {
		return maskKey(stored) + dimStyle.Render("  saved")
	}
	if strings.EqualFold(m.cfg.Provider, llm.ProviderKhateway) {
		return dimStyle.Render("not set · enter to sign in or paste")
	}
	return dimStyle.Render("not set · enter to paste")
}

// maskKey shows only a key's last four characters.
func maskKey(k string) string {
	if len(k) <= 4 {
		return "••••"
	}
	return "••••" + k[len(k)-4:]
}

func (m *Model) mcpListView() []string {
	names := sortedServerNames(m.cfg.MCPServers)
	if len(names) == 0 {
		return []string{dimStyle.Render("no servers yet · n to add one")}
	}
	s := m.settings
	cur := min(s.listCur, len(names)-1)
	out := make([]string, 0, len(names))
	for i, n := range names {
		sc := m.cfg.MCPServers[n]
		line := n + "  " + dimStyle.Render(clip(strings.Join(append([]string{sc.Command}, sc.Args...), " "), 40))
		if i == cur {
			out = append(out, pickSel.Render("❯ "+line))
		} else {
			out = append(out, "  "+line)
		}
	}
	return listWindow(out, cur, listMaxRows(m.height))
}

func (m *Model) hookListView() []string {
	entries := m.hookEntries()
	if len(entries) == 0 {
		return []string{dimStyle.Render("no hooks yet · n to add one")}
	}
	s := m.settings
	cur := min(s.listCur, len(entries)-1)
	out := make([]string, 0, len(entries))
	for i, e := range entries {
		h := m.hookAt(e)
		kind := "post"
		if e.pre {
			kind = "pre "
		}
		line := dimStyle.Render(kind) + "  " + clip(h.Command, 46)
		if len(h.Tools) > 0 {
			line += dimStyle.Render("  [" + strings.Join(h.Tools, ",") + "]")
		}
		if i == cur {
			out = append(out, pickSel.Render("❯ "+line))
		} else {
			out = append(out, "  "+line)
		}
	}
	return listWindow(out, cur, listMaxRows(m.height))
}

// serverFormView renders an open form: label + live input per text row,
// then the enum row and the save row. It is host-agnostic so both the
// settings dialog and the /mcp panel's add form render identically.
func serverFormView(f *serverForm) []string {
	labels := f.labels()
	rows := make([]string, 0, len(labels)+2)
	for i, l := range labels {
		marker := "  "
		if f.field == i {
			marker = "❯ "
		}
		rows = append(rows, marker+fmt.Sprintf("%-10s", l)+f.inputs[i].View())
	}
	marker := "  "
	if f.field == len(f.inputs) {
		marker = "❯ "
	}
	rows = append(rows, marker+fmt.Sprintf("%-10s", f.enumLabel())+f.enumValue())
	if f.field == len(f.inputs)+1 {
		rows = append(rows, pickSel.Render("❯ save · enter to commit"))
	} else {
		rows = append(rows, "  "+dimStyle.Render("save · enter to commit"))
	}
	return rows
}

// labels names the form's text rows in field order.
func (f *serverForm) labels() []string {
	switch f.kind {
	case formMCPServer:
		return []string{"name", "command", "args", "env"}
	case formProvider:
		return []string{"name", "base url"}
	}
	return []string{"command", "tools"}
}

// enumLabel names the form's enum row.
func (f *serverForm) enumLabel() string {
	switch f.kind {
	case formMCPServer:
		return "risk"
	case formProvider:
		return "protocol"
	}
	return "type"
}

// enumValue renders the enum row for the current selection.
func (f *serverForm) enumValue() string {
	switch f.kind {
	case formMCPServer:
		if riskChoices[f.enum] == "" {
			return "exec (default)" + dimStyle.Render("  ←/→ cycle")
		}
		return riskChoices[f.enum] + dimStyle.Render("  ←/→ cycle")
	case formProvider:
		if f.enum == 0 {
			return "openai" + dimStyle.Render("  · <base>/models  ←/→ cycle")
		}
		return "anthropic" + dimStyle.Render("  · <base>/v1/models  ←/→ cycle")
	}
	if f.enum == 0 {
		return "pre_tool" + dimStyle.Render("  · exit 2 blocks the call  ←/→ cycle")
	}
	return "post_tool" + dimStyle.Render("  · informational only  ←/→ cycle")
}

// --- helpers -------------------------------------------------------------------

// sortedServerNames lists MCP server names alphabetically, matching the
// startup registration order.
func sortedServerNames(servers map[string]config.MCPServer) []string {
	names := make([]string, 0, len(servers))
	for n := range servers {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// --- providers -----------------------------------------------------------------

// providerNames lists every provider khode can speak: the built-ins
// first, then custom providers alphabetically.
func (m *Model) providerNames() []string {
	customs := make([]string, 0, len(m.cfg.CustomProviders))
	for n := range m.cfg.CustomProviders {
		customs = append(customs, n)
	}
	sort.Strings(customs)
	return append(llm.Names(), customs...)
}

// providerNameTaken reports whether name collides with a built-in or
// an already-configured custom provider, ignoring case (lookups treat
// "Groq" and "groq" as one name). The entry being edited — origName,
// "" when adding — does not count as a collision, so re-casing its own
// name stays allowed.
func (m *Model) providerNameTaken(name, origName string) bool {
	if config.IsBuiltinProvider(name) {
		return true
	}
	for n := range m.cfg.CustomProviders {
		if strings.EqualFold(n, name) && !strings.EqualFold(n, origName) {
			return true
		}
	}
	return false
}

func (m *Model) providerListKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings
	names := m.providerNames()
	switch msg.String() {
	case "up", "k", "ctrl+p":
		if s.listCur > 0 {
			s.listCur--
		}
	case "down", "j", "ctrl+n":
		if s.listCur < len(names)-1 {
			s.listCur++
		}
	case "n":
		m.openProviderForm("")
	case "enter":
		if len(names) == 0 {
			break
		}
		name := names[min(s.listCur, len(names)-1)]
		if config.IsBuiltinProvider(name) {
			m.switchProvider(name)
			s.view = viewRows
			break
		}
		m.openProviderForm(name)
	case "d":
		if len(names) == 0 {
			break
		}
		name := names[min(s.listCur, len(names)-1)]
		switch {
		case config.IsBuiltinProvider(name):
			s.savedMsg = "✗ built-in providers can't be removed"
		case name == m.cfg.Provider:
			s.savedMsg = "✗ " + name + " is active — switch first"
		default:
			delete(m.cfg.CustomProviders, name)
			m.cfg.SetModelChoices(name, nil)
			s.listCur = max(0, min(s.listCur, len(names)-2)-0)
			m.saveSettings("provider " + name + " removed")
		}
	case "esc":
		s.view = viewRows
	}
	return nil
}

func (m *Model) providerListView() []string {
	names := m.providerNames()
	s := m.settings
	cur := min(s.listCur, len(names)-1)
	out := make([]string, 0, len(names))
	for i, n := range names {
		line := n
		switch {
		case config.IsBuiltinProvider(n):
			line += dimStyle.Render("  built-in")
			if u := m.cfg.BaseURL(n); u != "" {
				line += dimStyle.Render("  " + clip(u, 30))
			}
		default:
			line += dimStyle.Render("  " + clip(m.cfg.CustomProviders[n].BaseURL, 36))
		}
		if n == m.cfg.Provider {
			line += "  " + okStyle.Render("●")
		}
		if i == cur {
			out = append(out, pickSel.Render("❯ "+line))
		} else {
			out = append(out, "  "+line)
		}
	}
	return listWindow(out, cur, listMaxRows(m.height))
}

// openProviderForm edits the named custom provider, or a new one when
// name is "".
func (m *Model) openProviderForm(name string) {
	cp := m.cfg.CustomProviders[name] // zero value when new
	inputs := make([]textinput.Model, 2)
	for i := range inputs {
		inputs[i] = textinput.New()
		inputs[i].Prompt = ""
		inputs[i].SetWidth(52)
	}
	inputs[0].SetValue(name)
	inputs[0].Placeholder = "unique name (e.g. groq, ollama)"
	inputs[1].SetValue(cp.BaseURL)
	inputs[1].Placeholder = "http://localhost:11434/v1"
	enum := 0
	if cp.Kind == "anthropic" {
		enum = 1
	}
	m.settings.form = &serverForm{kind: formProvider, origName: name, inputs: inputs, enum: enum}
	m.settings.form.focus()
}

// --- model picker ----------------------------------------------------------------

// modelPicker is the model-selection sub-view for one provider: the
// cached choices (fetched or added manually), a fetch trigger, and a
// manual-add input.
type modelPicker struct {
	provider string
	list     []string
	cursor   int
	fetching bool
	adding   bool
	input    textinput.Model
	status   string // fetch outcome, shown under the list
}

// openModelRow starts model selection for the active provider: a picker
// for custom providers and khateway (whose model lists are unknowable
// without asking the endpoint, so they auto-fetch) or any provider with
// cached choices, and the plain editor otherwise — typing a model name
// stays the zero-setup path for built-ins.
func (m *Model) openModelRow() tea.Cmd {
	choices := m.cfg.ModelChoices[m.cfg.Provider]
	_, custom := m.cfg.CustomProviders[m.cfg.Provider]
	khateway := strings.EqualFold(m.cfg.Provider, "khateway")
	dynamic := custom || khateway
	if !dynamic && len(choices) == 0 {
		m.openEditor(rowModel)
		return nil
	}
	p := &modelPicker{provider: m.cfg.Provider, list: choices, input: textinput.New()}
	p.input.Prompt = ""
	p.input.SetWidth(40)
	p.input.Placeholder = "model name"
	p.cursor = p.index(activeModel(m.cfg))
	p.fetching = dynamic && len(p.list) == 0
	m.settings.view = viewModels
	m.settings.models = p
	if p.fetching {
		return m.fetchModelsCmd()
	}
	return nil
}

// activeModel returns the provider's active model ("" when unset).
func activeModel(cfg *config.Config) string { return cfg.Model() }

// index returns the position of model in the list, 0 when absent.
func (p *modelPicker) index(model string) int {
	for i, m := range p.list {
		if m == model {
			return i
		}
	}
	return 0
}

func (m *Model) modelPickerKey(msg tea.KeyMsg) tea.Cmd {
	s := m.settings
	p := s.models
	if p.adding {
		switch msg.String() {
		case "enter":
			name := strings.TrimSpace(p.input.Value())
			p.adding = false
			p.input.SetValue("")
			if name != "" {
				m.cfg.AddModelChoice(p.provider, name)
				m.cfg.SetModel(name)
				m.saveSettings("model → " + name)
				m.refreshModelPicker()
			}
		case "esc":
			p.adding = false
			p.input.SetValue("")
		default:
			var cmd tea.Cmd
			p.input, cmd = p.input.Update(msg)
			return cmd
		}
		return nil
	}

	switch msg.String() {
	case "up", "k", "ctrl+p":
		if p.cursor > 0 {
			p.cursor--
		}
	case "down", "j", "ctrl+n":
		if p.cursor < len(p.list)-1 {
			p.cursor++
		}
	case "f":
		if p.fetching {
			break
		}
		p.fetching = true
		p.status = ""
		return m.fetchModelsCmd()
	case "n":
		p.adding = true
		p.input.Focus()
	case "d":
		if len(p.list) == 0 {
			break
		}
		name := p.list[min(p.cursor, len(p.list)-1)]
		if name == m.cfg.Models[m.cfg.Provider] {
			delete(m.cfg.Models, m.cfg.Provider)
		}
		m.cfg.RemoveModelChoice(p.provider, name)
		m.saveSettings("model " + name + " removed")
		m.refreshModelPicker()
	case "enter":
		if len(p.list) == 0 {
			break
		}
		name := p.list[min(p.cursor, len(p.list)-1)]
		m.cfg.SetModel(name)
		m.saveSettings("model → " + name)
		s.view = viewRows
		s.models = nil
	case "esc":
		s.view = viewRows
		s.models = nil
	}
	return nil
}

// refreshModelPicker reloads the list from config after an add or
// remove, keeping the cursor on the active model.
func (m *Model) refreshModelPicker() {
	p := m.settings.models
	p.list = append([]string(nil), m.cfg.ModelChoices[p.provider]...)
	p.cursor = min(p.cursor, max(0, len(p.list)-1))
	p.cursor = p.index(activeModel(m.cfg))
}

// modelsFetchedMsg carries one model-list fetch result.
type modelsFetchedMsg struct {
	provider string
	models   []string
	err      error
}

// fetchModelsCmd queries the active provider's endpoint for its model
// list, off the UI goroutine (the request can take seconds).
func (m *Model) fetchModelsCmd() tea.Cmd {
	provider := m.cfg.Provider
	proto := m.cfg.ProviderProtocol(provider)
	key, baseURL := m.cfg.Credentials(m.auth, provider)
	return func() tea.Msg {
		models, err := llm.FetchModels(context.Background(), proto, key, baseURL)
		return modelsFetchedMsg{provider: provider, models: models, err: err}
	}
}

// applyFetchedModels stores a finished fetch into whichever consumer is
// open: the /model dialog, the settings model picker, or the
// walkthrough's model step. Stale results — nothing open, or the
// provider switched meanwhile — are dropped on the floor.
func (m *Model) applyFetchedModels(msg modelsFetchedMsg) {
	if p := m.modelPick; p != nil && p.provider == msg.provider {
		p.fetching = false
		if msg.err != nil {
			p.status = clip("fetch failed: "+msg.err.Error(), 56) +
				dimStyle.Render("  · f retry")
			return
		}
		m.cacheModelChoices(msg.provider, msg.models)
		p.all = msg.models
		m.refreshModelPick()
		return
	}

	if s := m.settings; s != nil && s.models != nil && s.view == viewModels && s.models.provider == msg.provider {
		p := s.models
		p.fetching = false
		if msg.err != nil {
			p.status = clip("fetch failed: "+msg.err.Error(), 56) +
				dimStyle.Render("  · n add manually · f retry")
			return
		}
		m.cacheModelChoices(msg.provider, msg.models)
		p.list = msg.models
		p.cursor = p.index(activeModel(m.cfg))
		if len(p.list) == 0 {
			p.status = "endpoint listed no models · n add manually"
		} else {
			p.status = fmt.Sprintf("fetched %d models · enter to use one", len(p.list))
		}
		return
	}

	w := m.welcome
	if w == nil || w.step != welcomeModel || msg.provider != m.cfg.Provider {
		return
	}
	w.fetching = false
	if msg.err != nil {
		w.fetchErr = clip(msg.err.Error(), 56)
		return
	}
	// Cache the list even before a pick: Model() falls back to the first
	// cached choice, and /settings → model reopens it without a re-fetch.
	m.cacheModelChoices(msg.provider, msg.models)
	w.models = msg.models
	w.mCur = 0
}

// cacheModelChoices persists a fetched list as the provider's cached
// choices; a save failure surfaces as lastErr, not a dead fetch.
func (m *Model) cacheModelChoices(provider string, models []string) {
	m.cfg.SetModelChoices(provider, models)
	if err := m.cfg.Save(); err != nil {
		m.lastErr = err.Error()
	}
}

// modelPickerView renders the list (sliding window when long) with the
// active model marked, the manual-add input, and the fetch status.
func (m *Model) modelPickerView() []string {
	p := m.settings.models
	var out []string
	if p.adding {
		out = append(out, pickSel.Render("❯ ")+fmt.Sprintf("%-6s", "new")+p.input.View())
	}
	if len(p.list) == 0 && !p.adding && !p.fetching {
		out = append(out, dimStyle.Render("no models yet · f fetch · n add manually"))
	}

	const windowH = 12
	active := activeModel(m.cfg)
	start := 0
	if len(p.list) > windowH {
		start = min(max(0, p.cursor-windowH/2), len(p.list)-windowH)
	}
	for i := start; i < min(len(p.list), start+windowH); i++ {
		cur := "  "
		if i == p.cursor && !p.adding {
			cur = pickSel.Render("❯ ")
		}
		dot := "  "
		if p.list[i] == active {
			dot = okStyle.Render("● ")
		}
		name := p.list[i]
		if i == p.cursor && !p.adding {
			name = pickSel.Render(name)
		}
		out = append(out, cur+dot+name)
	}
	if len(p.list) > windowH {
		out = append(out, dimStyle.Render(fmt.Sprintf("  %d/%d · ↑/↓ more", p.cursor+1, len(p.list))))
	}
	if p.fetching {
		out = append(out, m.spinner.View()+statusStyle.Render(" fetching models…"))
	}
	if p.status != "" {
		out = append(out, dimStyle.Render(p.status))
	}
	return out
}
