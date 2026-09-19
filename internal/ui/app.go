// Package ui contains the Bubble Tea front-end. The agent/provider machinery
// runs in a background goroutine and streams llm.Event values into the TUI
// through the waitForEvents command chain.
package ui

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/debug"
	"khode/internal/hooks"
	"khode/internal/llm"
	"khode/internal/mcp"
	"khode/internal/perm"
	"khode/internal/tools"

	"github.com/charmbracelet/bubbles/key"
	"github.com/charmbracelet/bubbles/spinner"
	"github.com/charmbracelet/bubbles/textarea"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/lipgloss"
)

const (
	Version        = "0.1.0"
	minInputHeight = 1
	maxInputHeight = 6
)

// uiMessageKind separates the block styles inside the chat pane.
type uiMessageKind int

const (
	kindText uiMessageKind = iota
	kindThinking
	kindToolCall
	kindToolResult
)

// uiMessage is a message shown in the chat pane. Only messages with
// history=true mirror the session transcript; tool blocks display agent
// activity and are display-only.
type uiMessage struct {
	role      llm.Role
	kind      uiMessageKind
	raw       string
	rendered  string
	streaming bool
	isErr     bool
	full      bool // tool results meant to be read whole (todo lists)
	history   bool
}

// Model is the root Bubble Tea model.
type Model struct {
	cfg      *config.Config
	auth     *config.Auth // stored API keys (~/.khode/auth.json)
	provider llm.Provider
	session  *agent.Session
	tools    *tools.Registry
	workdir  string

	width    int
	height   int
	viewport viewport.Model
	textarea textarea.Model
	spinner  spinner.Model

	messages []uiMessage

	picker     *picker     // session chooser overlay; nil when closed
	settings   *settings   // configuration overlay; nil when closed
	toolsPanel *toolsPanel // /tools overlay; nil when closed
	welcome    *welcome    // first-run walkthrough; nil when closed
	popup      *cmdPopup   // slash-command completion above the input; nil when hidden

	streaming bool
	cancel    context.CancelFunc
	events    <-chan llm.Event
	// partial accumulates the in-flight reply and partialThink the
	// in-flight thinking. Both are pointers because Model is copied by
	// value through Update; a value Builder would trip its
	// copied-by-value check whenever the escape analyzer chooses not to
	// alias the copies.
	partial      *strings.Builder
	partialThink *strings.Builder

	// ctxIn/ctxOut are the most recent request's usage: ctxIn is the
	// transcript size the provider saw, so the status line can render
	// how full the model's context window is.
	ctxIn  int64
	ctxOut int64

	// mcpClients holds the running MCP server connections so /settings
	// can start and stop servers live.
	mcpClients map[string]*mcp.Client

	approvals *agent.Bridge  // permission questions to/from the agent loop
	perm      *agent.Request // open approval dialog; nil when closed

	inTokens  int64
	outTokens int64
	cost      float64
	hasCost   bool // price known for the models used so far

	// turnStart marks when the in-flight turn began (the status line
	// counts it up live); lastTurn is how long the previous one took.
	turnStart time.Time
	lastTurn  time.Duration

	lastErr string
}

// New builds the root model, restoring prior conversation history from the
// session transcript (used by --resume).
func New(cfg *config.Config, auth *config.Auth, p llm.Provider, sess *agent.Session, reg *tools.Registry, mcpClients map[string]*mcp.Client, workdir string) Model {
	ta := textarea.New()
	ta.Placeholder = "Ask khode to do something…"
	ta.Prompt = "❯ "
	ta.ShowLineNumbers = false
	ta.CharLimit = 0
	ta.MaxHeight = maxInputHeight
	// bubbles paints the focused cursor line with a hard black
	// background, which renders as a black strip inside the input box on
	// dark terminal themes; drop it so the line keeps the theme's colors.
	ta.FocusedStyle.CursorLine = lipgloss.NewStyle()
	ta.BlurredStyle.CursorLine = lipgloss.NewStyle()
	promptStyle := lipgloss.NewStyle().Foreground(colGreen)
	ta.FocusedStyle.Prompt = promptStyle
	ta.BlurredStyle.Prompt = promptStyle
	phStyle := lipgloss.NewStyle().Foreground(colDim)
	ta.FocusedStyle.Placeholder = phStyle
	ta.BlurredStyle.Placeholder = phStyle

	sp := spinner.New(spinner.WithSpinner(spinner.MiniDot))
	sp.Style = lipgloss.NewStyle().Foreground(colCyan)
	// Newline rides alt+enter only. shift+enter would be the standard,
	// but bubbletea v1 has no kitty-protocol key parsing, so no terminal
	// sequence for it is representable; alt is the only modifier enter
	// every terminal distinguishes. Users on kitty-protocol terminals
	// can remap shift+enter to send ESC+CR in their terminal config.
	ta.KeyMap.InsertNewline = key.NewBinding(
		key.WithKeys("alt+enter"),
		key.WithHelp("alt+enter", "newline"),
	)
	ta.Focus()
	ta.SetWidth(60)
	ta.SetHeight(minInputHeight)

	m := Model{
		cfg:          cfg,
		auth:         auth,
		provider:     p,
		session:      sess,
		tools:        reg,
		mcpClients:   mcpClients,
		workdir:      workdir,
		textarea:     ta,
		spinner:      sp,
		viewport:     viewport.New(60, 10),
		partial:      new(strings.Builder),
		partialThink: new(strings.Builder),
		approvals:    agent.NewBridge(),
	}

	m.registerTaskTool()
	// The plan tool rides the same bridge: approval switches the app to
	// accept-edits mode (answerPerm does the switching). It holds no
	// provider reference, so it never needs re-registration.
	modeFn := func() perm.Mode { return perm.Parse(cfg.PermissionMode) }
	reg.Register(agent.NewPlanTool(m.approvals, modeFn))

	for _, msg := range sess.Messages() {
		switch {
		case msg.Role == llm.RoleTool && msg.ToolResult != nil:
			m.messages = append(m.messages, uiMessage{
				role:    msg.Role,
				kind:    kindToolResult,
				raw:     msg.ToolResult.Content,
				isErr:   msg.ToolResult.IsError,
				history: true,
			})
		case msg.Role == llm.RoleAssistant && len(msg.ToolCalls) > 0:
			if msg.Thinking != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, kind: kindThinking, raw: msg.Thinking, history: true})
			}
			if msg.Content != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true})
			}
			for _, c := range msg.ToolCalls {
				m.messages = append(m.messages, uiMessage{
					role: msg.Role, kind: kindToolCall, raw: formatToolCall(c), history: true,
				})
			}
		default:
			if msg.Role == llm.RoleAssistant && msg.Thinking != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, kind: kindThinking, raw: msg.Thinking, history: true})
			}
			if msg.Content != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true})
			}
		}
	}
	m.banner()
	return m
}

// banner seeds the one notice a fresh chat starts with. The header
// already carries version, provider/model, session, and mode, so the
// banner only points at the commands that aren't visible anywhere.
func (m *Model) banner() {
	m.messages = append(m.messages, uiMessage{
		role: "system",
		raw:  "/help commands · /settings config",
	})
}

// registerTaskTool (re)registers the task tool against the current
// provider. Subagents read model, token budget, mode, and hooks live,
// but the provider was captured by value — re-registration is how a
// settings-overlay provider switch reaches them.
func (m *Model) registerTaskTool() {
	modeFn := func() perm.Mode { return perm.Parse(m.cfg.PermissionMode) }
	m.tools.Register(agent.NewTaskTool(agent.SubagentConfig{
		Provider:  m.provider,
		Workdir:   m.workdir,
		Model:     m.cfg.Model,
		MaxTokens: func() int { return m.cfg.MaxTokens },
		Mode:      modeFn,
		Approver:  m.approvals,
		Hooks:     func() *hooks.Runner { return hooks.New(m.cfg.Hooks, m.workdir) },
	}))
}

// hasCredentials reports whether turns may start on the active
// provider: key-optional providers (khateway — the gateway fronts
// upstream auth) always pass, everyone else needs a resolvable API key,
// so a turn isn't started just to fail with 401.
func (m *Model) hasCredentials() bool {
	if config.KeyOptional(m.cfg.Provider) {
		return true
	}
	key, _ := m.cfg.Credentials(m.auth, m.cfg.Provider)
	return key != ""
}

// modelLabel renders the active model, flagging a provider whose model
// is not set yet instead of showing an empty string.
func (m *Model) modelLabel() string {
	if s := m.cfg.Model(); s != "" {
		return s
	}
	return "(no model — /settings)"
}

// useSession makes sess the active conversation and resets the view.
// The context estimate resets with it: the new transcript is empty
// until the first usage report comes back.
func (m *Model) useSession(sess *agent.Session) {
	m.session = sess
	m.ctxIn, m.ctxOut = 0, 0
	m.messages = nil
	m.banner()
	m.renderAll()
}

// --- tea.Model -------------------------------------------------------------

type streamEventMsg struct{ ev llm.Event }

// streamClosedMsg arrives when the provider closed the event channel without
// a terminal event (e.g. ctx cancelled before we drained it).
type streamClosedMsg struct{}

// compactDoneMsg carries the outcome of a manual /compact run.
type compactDoneMsg struct {
	removed int
	err     error
}

func (m Model) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.spinner.Tick)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.textarea.SetWidth(max(10, m.width-4))
		m.relayout()
		m.invalidateRendered()
		m.renderAll()
		return m, nil

	case tea.MouseMsg:
		// Mouse capture is on (main.go), so the wheel arrives here and
		// scrolls the chat instead of the terminal's dead pre-launch
		// scrollback. Everything else (clicks, drags) is ignored;
		// shift+drag still selects text terminal-side.
		var cmd tea.Cmd
		m.viewport, cmd = m.viewport.Update(msg)
		return m, cmd

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case streamEventMsg:
		return m, m.handleStreamEvent(msg.ev)

	case streamClosedMsg:
		return m, m.finishStream()

	case compactDoneMsg:
		switch {
		case msg.err != nil:
			m.lastErr = fmt.Sprintf("compaction failed: %v", msg.err)
		case msg.removed == 0:
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: "nothing to compact · the conversation is already short"})
		default:
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: fmt.Sprintf("compacted · summarized %d messages (session transcript rewritten)", msg.removed)})
		}
		m.renderAll()
		return m, nil

	case permRequestMsg:
		if !m.streaming || m.events == nil {
			// Stale question from a turn that already ended: decline on
			// the user's behalf so nothing blocks.
			msg.req.Answer(false)
			return m, nil
		}
		m.perm = &msg.req
		return m, nil // dialog open; the pump resumes when it is answered

	case mcpApplyMsg:
		m.applyMCPResult(msg)
		return m, nil

	case modelsFetchedMsg:
		m.applyFetchedModels(msg)
		return m, nil

	case tea.KeyMsg:
		if m.perm != nil {
			return m, m.permKey(msg)
		}
		if m.welcome != nil {
			return m, m.welcomeKey(msg)
		}
		if m.settings != nil {
			return m, m.settingsKey(msg)
		}
		if m.toolsPanel != nil {
			return m, m.toolsKey(msg)
		}
		if m.picker != nil {
			return m, m.pickerKey(msg)
		}
		if m.popup != nil {
			// The completion list answers first; keys it skips fall
			// through to the textarea below.
			if cmd, done := m.popupKey(msg); done {
				return m, cmd
			}
		}
		switch {
		case msg.Type == tea.KeyCtrlC:
			m.stopStream()
			return m, tea.Quit
		case msg.Type == tea.KeyEsc && m.streaming:
			m.stopStream()
			return m, nil
		// alt+enter falls through to the textarea, whose InsertNewline
		// binding turns it into a newline.
		case msg.Type == tea.KeyEnter && !msg.Alt:
			if m.streaming {
				return m, nil
			}
			return m, m.submit()
		case msg.Type == tea.KeyPgUp || msg.Type == tea.KeyPgDown:
			// In alt screen the terminal's own scrollback is suspended,
			// so these are the only way back through the chat.
			var cmd tea.Cmd
			m.viewport, cmd = m.viewport.Update(msg)
			return m, cmd
		}
		var cmd tea.Cmd
		m.textarea, cmd = m.textarea.Update(msg)
		m.maybeGrowInput()
		m.syncPopup()
		return m, cmd
	}

	return m, nil
}

func (m Model) View() string {
	if m.width == 0 {
		return "starting…"
	}
	if m.perm != nil {
		return m.permView()
	}
	if m.welcome != nil {
		return m.welcomeView()
	}
	if m.settings != nil {
		return m.settingsView()
	}
	if m.toolsPanel != nil {
		return m.toolsView()
	}
	if m.picker != nil {
		return m.pickerView()
	}

	header := m.header()
	status := m.statusLine()
	border := inputBorder
	if m.streaming {
		border = inputBorderLive // the frame answers the stream in kind
	}
	inputBox := border.Render(m.textarea.View())
	help := m.helpLine()

	parts := []string{header, viewportStyle.Render(m.viewport.View()), status}
	if m.popup != nil {
		parts = append(parts, m.popupView()) // floats just above the input
	}
	parts = append(parts, inputBox, help)
	return lipgloss.JoinVertical(lipgloss.Left, parts...)
}

// header renders the chrome above the chat: the gradient wordmark and
// provider/model on the left, the session and a permission-mode chip on
// the right, over a quiet rule. The right side yields when the
// terminal is too narrow for both.
func (m Model) header() string {
	left := logo() +
		dimStyle.Render(fmt.Sprintf("  v%s · %s/%s", Version, m.provider.Name(), m.modelLabel()))
	right := dimStyle.Render(clip(m.session.Name(), 24)) + " " + modeChip.Render(string(m.mode()))
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 2 {
		right = ""
		gap = m.width - lipgloss.Width(left)
		if gap < 0 {
			gap = 0
		}
	}
	rule := lipgloss.NewStyle().Foreground(colBorder).Render(strings.Repeat("─", max(0, m.width)))
	return left + strings.Repeat(" ", gap) + right + "\n" + rule
}

// helpLine renders the bottom key reference: key names faint cyan,
// verbs dim.
func (m Model) helpLine() string {
	hints := []struct{ k, v string }{
		{"enter", "send"},
		{"alt+enter", "newline"},
		{"pgup/pgdn", "scroll"},
		{"esc", "stop stream"},
		{"ctrl+c", "quit"},
	}
	parts := make([]string, 0, len(hints))
	for _, h := range hints {
		parts = append(parts, helpKey.Render(h.k)+dimStyle.Render(" "+h.v))
	}
	return dimStyle.Width(m.width).Render(strings.Join(parts, dimStyle.Render(" · ")))
}

// --- streaming -------------------------------------------------------------

// waitForEvents blocks until either the stream produces an event or the
// approval bridge has a question; whichever the agent loop offers first.
func waitForEvents(ch <-chan llm.Event, reqs <-chan agent.Request) tea.Cmd {
	return func() tea.Msg {
		select {
		case ev, ok := <-ch:
			if !ok {
				return streamClosedMsg{}
			}
			return streamEventMsg{ev: ev}
		case req, ok := <-reqs:
			if !ok {
				return nil
			}
			return permRequestMsg{req: req}
		}
	}
}

// pump schedules the next poll of the stream and the approval bridge.
func (m *Model) pump() tea.Cmd {
	return waitForEvents(m.events, m.approvals.Requests())
}

func (m *Model) handleStreamEvent(ev llm.Event) tea.Cmd {
	switch e := ev.(type) {
	case llm.ThinkingDeltaEvent:
		m.ensureStreamingBlock(kindThinking)
		m.partialThink.WriteString(e.Text)
		if idx := len(m.messages) - 1; idx >= 0 && m.messages[idx].streaming {
			m.messages[idx].raw = m.partialThink.String()
		}
		m.renderAll()
		return m.pump()

	case llm.TextDeltaEvent:
		m.ensureStreamingBlock(kindText)
		m.partial.WriteString(e.Text)
		if idx := len(m.messages) - 1; idx >= 0 && m.messages[idx].streaming {
			m.messages[idx].raw = m.partial.String()
		}
		m.renderAll()
		return m.pump()

	case llm.ToolCallEvent:
		m.sealStreamingText()
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleAssistant, kind: kindToolCall, raw: formatToolCall(e.ToolCall),
		})
		m.renderAll()
		return m.pump()

	case llm.ToolResultEvent:
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleTool, kind: kindToolResult, raw: e.Output, isErr: e.IsError,
			full: e.Name == "todo",
		})
		m.renderAll()
		return m.pump()

	case llm.UsageEvent:
		m.inTokens += e.InputTokens
		m.outTokens += e.OutputTokens
		m.ctxIn, m.ctxOut = e.InputTokens, e.OutputTokens
		if c, ok := llm.CostEstimate(m.cfg.Model(), e.InputTokens, e.OutputTokens); ok {
			m.cost += c
			m.hasCost = true
		}
		return m.pump()

	case llm.CompactEvent:
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("context compacted · summarized %d earlier messages, %d recent turns kept in the transcript", e.Removed, e.Kept)})
		m.renderAll()
		return m.pump()

	case llm.ErrorEvent:
		if !errors.Is(e.Err, context.Canceled) {
			m.lastErr = e.Err.Error()
		}
		return m.finishStream()

	case llm.DoneEvent:
		return m.finishStream()
	}
	return m.pump()
}

// ensureStreamingBlock opens a fresh streaming bubble of the given kind
// when the last block is not one (turn start, a new round after tool
// calls, or the thinking ↔ answer switch within one round — the switch
// seals the old phase and appends the new one). A sealed block always
// carries content by the time the stream moves on.
func (m *Model) ensureStreamingBlock(kind uiMessageKind) {
	if len(m.messages) > 0 {
		last := &m.messages[len(m.messages)-1]
		if last.streaming {
			if last.kind == kind {
				return
			}
			last.streaming = false
			m.partial.Reset()
			m.partialThink.Reset()
		}
	}
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, kind: kind, streaming: true, history: true})
}

// sealStreamingText finalizes the open streaming bubble for display: the
// session write itself belongs to the agent loop, not the UI.
func (m *Model) sealStreamingText() {
	m.partial.Reset()
	m.partialThink.Reset()
	idx := len(m.messages) - 1
	if idx < 0 || !m.messages[idx].streaming {
		return
	}
	if m.messages[idx].raw == "" {
		m.messages = m.messages[:idx] // drop the empty streaming block
		return
	}
	m.messages[idx].streaming = false
}

// finishStream closes out the turn: finalize display and return the UI to
// ready state. Session writes happened in the agent loop.
func (m *Model) finishStream() tea.Cmd {
	m.streaming = false
	m.events = nil
	if m.cancel != nil {
		m.cancel()
		m.cancel = nil
	}
	if !m.turnStart.IsZero() {
		m.lastTurn = time.Since(m.turnStart)
		m.turnStart = time.Time{}
	}
	if m.perm != nil {
		// Defensive: a dialog outliving its turn is declined, never
		// left dangling.
		m.perm.Answer(false)
		m.perm = nil
	}

	m.sealStreamingText()
	if m.lastErr != "" {
		m.messages = append(m.messages, uiMessage{role: "system", raw: "error: " + m.lastErr})
		m.lastErr = ""
	}

	m.renderAll()
	return textarea.Blink
}

func (m *Model) stopStream() {
	if m.cancel != nil {
		m.cancel()
	}
}

// --- input handling ----------------------------------------------------------

func (m *Model) submit() tea.Cmd {
	input := strings.TrimSpace(m.textarea.Value())
	m.textarea.Reset()
	m.maybeGrowInput()
	m.closePopup()
	if input == "" {
		return nil
	}
	if strings.HasPrefix(input, "/") {
		return m.command(input)
	}
	if !m.hasCredentials() {
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("no API key for %s · open /settings → api key and paste one (or set %s)",
				m.cfg.Provider, m.cfg.APIKeyEnvName(m.cfg.Provider))})
		m.renderAll()
		return nil
	}
	if m.cfg.Model() == "" {
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("no model set for %s · open /settings → model (f fetches the list, n adds one)",
				m.cfg.Provider)})
		m.renderAll()
		return nil
	}

	m.messages = append(m.messages, uiMessage{role: llm.RoleUser, raw: input, history: true})
	m.renderAll()
	return m.startTurn(input)
}

// startTurn hands the user input to the agent loop. The loop owns session
// writes and streams events back through the same channel the provider
// pump consumed in earlier phases; permission questions ride the bridge.
func (m *Model) startTurn(input string) tea.Cmd {
	// Drop questions left over from an earlier turn so a stale dialog
	// can never open for the wrong call.
	for {
		select {
		case req := <-m.approvals.Requests():
			req.Answer(false)
			continue
		default:
		}
		break
	}

	ctx, cancel := context.WithCancel(context.Background())
	runner := &agent.Runner{
		Provider:  m.provider,
		Session:   m.session,
		Tools:     m.tools,
		Model:     m.cfg.Model(),
		MaxTokens: m.cfg.MaxTokens,
		System:    agent.SystemPrompt(m.workdir),
		Mode:      m.mode(),
		Approver:  m.approvals,
		Hooks:     hooks.New(m.cfg.Hooks, m.workdir),
	}
	debug.Printf("start turn: %s/%s session=%s", m.provider.Name(), m.cfg.Model(), m.session.Name())
	ch := runner.Run(ctx, input)

	m.cancel = cancel
	m.events = ch
	m.streaming = true
	m.lastErr = ""
	m.turnStart = time.Now()
	m.partial.Reset()
	m.partialThink.Reset()
	return tea.Batch(m.pump(), m.spinner.Tick)
}

// mode returns the active permission mode, normalizing unknown config
// values to the safe default.
func (m *Model) mode() perm.Mode { return perm.Parse(m.cfg.PermissionMode) }

// setMode switches the permission mode, persists the choice, and tells
// the user. /mode and plan approval both go through here.
func (m *Model) setMode(want perm.Mode) {
	m.cfg.PermissionMode = string(want)
	if err := m.cfg.Save(); err != nil {
		m.lastErr = err.Error()
	}
	m.messages = append(m.messages, uiMessage{role: "system",
		raw: fmt.Sprintf("mode → %s · %s", want, modeDescription(want))})
}

// mcpStatus reports every configured MCP server and how many of its
// tools made it into the registry; a configured server with zero tools
// failed to start or to answer tools/list at launch.
func (m *Model) mcpStatus() string {
	if len(m.cfg.MCPServers) == 0 {
		return "no MCP servers configured · add one with /settings → mcp servers"
	}
	names := make([]string, 0, len(m.cfg.MCPServers))
	for n := range m.cfg.MCPServers {
		names = append(names, n)
	}
	sort.Strings(names)

	var lines []string
	for _, n := range names {
		prefix := "mcp__" + n + "__"
		count := 0
		for _, tn := range m.tools.Names() {
			if strings.HasPrefix(tn, prefix) {
				count++
			}
		}
		if count == 0 {
			lines = append(lines, fmt.Sprintf("%s — unavailable (see launch warnings)", n))
			continue
		}
		var toolNames []string
		for _, tn := range m.tools.Names() {
			if strings.HasPrefix(tn, prefix) {
				toolNames = append(toolNames, strings.TrimPrefix(tn, prefix))
			}
		}
		lines = append(lines, fmt.Sprintf("%s — %d tools: %s", n, count, strings.Join(toolNames, ", ")))
	}
	return strings.Join(lines, "\n")
}

// runCompact summarizes older turns now, off the UI goroutine. The loop
// config mirrors startTurn so the forced compaction matches what the
// next automatic one would do.
func (m *Model) runCompact() tea.Cmd {
	runner := &agent.Runner{
		Provider:  m.provider,
		Session:   m.session,
		Tools:     m.tools,
		Model:     m.cfg.Model(),
		MaxTokens: m.cfg.MaxTokens,
		System:    agent.SystemPrompt(m.workdir),
		Mode:      m.mode(),
		Approver:  m.approvals,
	}
	return func() tea.Msg {
		n, err := runner.Compact(context.Background())
		return compactDoneMsg{removed: n, err: err}
	}
}

func (m *Model) command(input string) tea.Cmd {
	parts := strings.Fields(input)
	switch parts[0] {
	case "/help":
		m.messages = append(m.messages, uiMessage{role: "system", raw: helpText()})

	case "/settings", "/config":
		m.OpenSettings(rowProvider)

	case "/mode":
		if len(parts) < 2 {
			var lines []string
			lines = append(lines, fmt.Sprintf("usage: /mode <name> (current: %s)", m.mode()))
			for _, mo := range perm.Modes() {
				marker := "  "
				if m.mode() == mo {
					marker = "❯ "
				}
				lines = append(lines, marker+string(mo)+" — "+modeDescription(mo))
			}
			m.messages = append(m.messages, uiMessage{role: "system", raw: strings.Join(lines, "\n")})
			break
		}
		want := perm.Parse(parts[1])
		if string(want) != strings.ToLower(parts[1]) {
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: fmt.Sprintf("unknown mode %q · try /mode for the list", parts[1])})
			break
		}
		m.setMode(want)

	case "/tools":
		m.openTools()

	case "/mcp":
		m.messages = append(m.messages, uiMessage{role: "system", raw: m.mcpStatus()})

	case "/compact":
		if m.streaming {
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: "wait for the current turn to finish, then /compact"})
			break
		}
		if !m.hasCredentials() {
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: fmt.Sprintf("no API key for %s · compaction needs one · see /settings",
					m.cfg.Provider)})
			break
		}
		return m.runCompact()

	case "/new":
		var (
			sess *agent.Session
			err  error
		)
		if len(parts) > 1 {
			sess, err = agent.NewSessionNamed(config.SessionsDir(), strings.Join(parts[1:], "-"))
		} else {
			sess, err = agent.NewSession(config.SessionsDir())
		}
		switch {
		case errors.Is(err, agent.ErrSessionExists):
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: fmt.Sprintf("session %q already exists · open it with /sessions",
					strings.Join(parts[1:], "-"))})
		case err != nil:
			m.lastErr = err.Error()
		default:
			m.useSession(sess)
		}

	case "/sessions":
		entries, err := agent.LoadSessions(config.SessionsDir())
		switch {
		case errors.Is(err, agent.ErrNoSessions):
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: "no sessions yet"})
		case err != nil:
			m.lastErr = err.Error()
		default:
			m.OpenPicker(entries)
		}

	case "/model":
		if len(parts) < 2 {
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: fmt.Sprintf("usage: /model <name> (current: %s/%s)", m.provider.Name(), m.cfg.Model())})
		} else {
			m.cfg.SetModel(parts[1])
			if err := m.cfg.Save(); err != nil {
				m.lastErr = err.Error()
			}
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: fmt.Sprintf("model → %s/%s", m.provider.Name(), m.cfg.Model())})
		}

	case "/exit", "/quit":
		return tea.Quit

	default:
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("unknown command %s · try /help", parts[0])})
	}
	m.renderAll()
	return nil
}

// --- rendering --------------------------------------------------------------

// ctxWarnFrac is the context fullness where the status meter turns
// warning-colored; it mirrors the agent loop's compaction trigger.
const ctxWarnFrac = 0.8

// ctxUsage reports how full the model's context window is, from the
// most recent request: its input tokens are the transcript the provider
// saw, plus the reply that has since joined it. ok is false until the
// first usage report of the session.
func (m *Model) ctxUsage() (pct int, warn bool, ok bool) {
	if m.ctxIn <= 0 {
		return 0, false, false
	}
	window := llm.ContextWindow(m.cfg.Model())
	if window <= 0 {
		return 0, false, false
	}
	used := m.ctxIn + m.ctxOut
	return min(int(used*100/int64(window)), 100),
		float64(used) >= ctxWarnFrac*float64(window), true
}

// ctxLabel renders the status-line context segment: a fullness bar
// ahead of the "ctx NN%" label, warning-colored once compaction is
// near.
func (m *Model) ctxLabel() string {
	pct, warn, ok := m.ctxUsage()
	if !ok {
		return ""
	}
	label := fmt.Sprintf("ctx %d%%", pct)
	bar := meter(float64(pct)/100, 8, warn) + " "
	if warn {
		return bar + warnStyle.Render(label)
	}
	return bar + dimStyle.Render(label)
}

func (m *Model) statusLine() string {
	var state string
	switch {
	case m.streaming:
		elapsed := time.Since(m.turnStart).Truncate(time.Second)
		state = m.spinner.View() + statusStyle.Render("working") +
			dimStyle.Render(" · "+elapsed.String()+" · esc to stop")
	case m.lastErr != "":
		state = errorStyle.Render("✗ " + clip(m.lastErr, max(20, m.width/2)))
	default:
		state = okStyle.Render("● ready")
		if m.lastTurn > 0 {
			state += dimStyle.Render(" · last turn " + m.lastTurn.Truncate(time.Second).String())
		}
	}
	segs := []string{
		dimStyle.Render(fmt.Sprintf("in %s · out %s",
			humanTokens(m.inTokens), humanTokens(m.outTokens))),
	}
	if c := m.ctxLabel(); c != "" {
		segs = append(segs, c)
	}
	segs = append(segs, dimStyle.Render(m.costLabel()))
	tok := strings.Join(segs, dimStyle.Render(" · "))

	gap := m.width - lipgloss.Width(state) - lipgloss.Width(tok)
	if gap < 1 {
		gap = 1
	}
	return state + strings.Repeat(" ", gap) + tok
}

// block renders one chat message, caching the result until invalidated.
func (m *Model) block(i int, width int) string {
	msg := m.messages[i]
	if msg.rendered != "" && !msg.streaming {
		return msg.rendered
	}

	var out string
	switch {
	case msg.kind == kindToolCall:
		out = toolCallBlock(msg.raw, width)
	case msg.kind == kindThinking:
		out = thinkStyle.Width(width).Render("✻ " + msg.raw)
	case msg.kind == kindToolResult:
		if msg.full {
			out = resultStyle.Width(width).Render(fullResultBody(msg.raw))
			break
		}
		body := summarizeToolResult(msg.raw)
		style := resultStyle
		prefix := "⎿  "
		if msg.isErr {
			style = errorStyle
			prefix = "⎿  error: "
		}
		out = style.Width(width).Render(prefix + body)
	case msg.role == llm.RoleUser:
		out = userMark.Render("❯ ") + lipgloss.NewStyle().Width(width).Render(msg.raw)
	case msg.role == llm.RoleAssistant:
		if msg.streaming {
			out = dimStyle.Width(width).Render(msg.raw) + streamCursor.Render("▌")
		} else {
			out = renderMarkdown(msg.raw, width)
		}
	default:
		out = systemStyle.Width(width).Render("· " + msg.raw)
	}

	msg.rendered = out
	m.messages[i] = msg
	return out
}

// renderAll rebuilds the viewport content from all messages.
func (m *Model) renderAll() {
	if m.width == 0 {
		return
	}
	blocks := make([]string, 0, len(m.messages))
	for i := range m.messages {
		blocks = append(blocks, strings.TrimSpace(m.block(i, m.viewport.Width-2)))
	}
	m.viewport.SetContent(strings.Join(blocks, "\n\n"))
	m.viewport.GotoBottom()
}

func (m *Model) invalidateRendered() {
	for i := range m.messages {
		m.messages[i].rendered = ""
	}
}

// relayout recomputes the viewport size from the current window and input.
func (m *Model) relayout() {
	inputH := m.textarea.Height() + 2 // rounded border
	// header line + rule + status + help; the popup carves out its own
	// rows from the viewport while it is open.
	vh := m.height - inputH - 4 - m.popupHeight()
	if vh < 3 {
		vh = 3
	}
	m.viewport.Width = m.width
	m.viewport.Height = vh
}

func (m *Model) maybeGrowInput() {
	lines := strings.Count(m.textarea.Value(), "\n") + 1
	h := min(maxInputHeight, max(minInputHeight, lines))
	if h != m.textarea.Height() {
		m.textarea.SetHeight(h)
		m.relayout()
	}
}

// --- helpers -----------------------------------------------------------------

// renderMarkdown renders complete assistant messages with glamour.
func renderMarkdown(raw string, width int) string {
	w := width
	if w < 20 {
		w = 20
	}
	if w > 160 {
		w = 160
	}
	r, err := glamour.NewTermRenderer(glamour.WithWordWrap(w), glamour.WithAutoStyle())
	if err != nil {
		return raw
	}
	out, err := r.Render(raw)
	if err != nil {
		return raw
	}
	return out
}

func humanTokens(n int64) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1e6)
	case n >= 1_000:
		return fmt.Sprintf("%.1fk", float64(n)/1e3)
	default:
		return fmt.Sprintf("%d", n)
	}
}

// toolResultPreview caps how many lines of a tool result the chat shows.
const toolResultPreviewLines = 2

// formatToolCall renders a tool call as one compact line: name plus
// single-line arguments.
func formatToolCall(c llm.ToolCall) string {
	args := compactJSON(c.Input)
	line := c.Name
	if args != "" && args != "{}" {
		line += " " + args
	}
	return truncate(line, 120)
}

// toolCallBlock renders a tool call two-tone: the ⏺ marker and tool
// name in cyan, the arguments dim behind them.
func toolCallBlock(raw string, width int) string {
	name, args := raw, ""
	if i := strings.IndexByte(raw, ' '); i >= 0 {
		name, args = raw[:i], raw[i+1:]
	}
	out := toolStyle.Render("⏺ " + name)
	if args == "" {
		return out
	}
	room := width - 4 - lipgloss.Width(name)
	if room < 8 {
		room = 8
	}
	return out + dimStyle.Render(" "+clip(args, room))
}

// summarizeToolResult renders a tool result preview: the first lines with
// a "+N more lines" note when truncated.
func summarizeToolResult(raw string) string {
	raw = strings.TrimRight(raw, "\n")
	if raw == "" {
		return "(no output)"
	}
	lines := strings.Split(raw, "\n")
	shown := lines
	switch {
	case len(lines) > toolResultPreviewLines:
		shown = lines[:toolResultPreviewLines]
		return truncate(strings.Join(shown, " · "), 160) +
			fmt.Sprintf("  (+%d more lines)", len(lines)-toolResultPreviewLines)
	}
	return truncate(strings.Join(shown, " · "), 200)
}

// fullResultBody indents a multi-line tool result under the result
// marker, for tools whose output is the point (the todo list).
func fullResultBody(raw string) string {
	lines := strings.Split(strings.TrimRight(raw, "\n"), "\n")
	for i := 1; i < len(lines); i++ {
		lines[i] = "   " + lines[i]
	}
	return "⎿  " + strings.Join(lines, "\n")
}

// compactJSON squeezes a tool call's input onto one line.
func compactJSON(raw json.RawMessage) string {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return string(raw)
	}
	return buf.String()
}

// truncate cuts s to max runes, marking the cut with an ellipsis.
func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max-1]) + "…"
}

// costLabel renders the running session cost; unknown models show a dash.
func (m *Model) costLabel() string {
	if !m.hasCost {
		return "$–"
	}
	if m.cost >= 1 {
		return fmt.Sprintf("$%.2f", m.cost)
	}
	return fmt.Sprintf("$%.4f", m.cost)
}
