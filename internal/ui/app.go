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
	"strings"
	"time"

	"github.com/muesli/reflow/wordwrap"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/debug"
	"khode/internal/hooks"
	"khode/internal/llm"
	"khode/internal/mcp"
	"khode/internal/perm"
	"khode/internal/tools"

	"charm.land/bubbles/v2/key"
	"charm.land/bubbles/v2/spinner"
	"charm.land/bubbles/v2/textarea"
	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

const (
	Version        = "0.1.0"
	minInputHeight = 1
	maxInputHeight = 6

	// wheelStep is how many lines one wheel tick scrolls, the
	// conventional three-line notches of a mouse wheel.
	wheelStep = 3
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
	final     bool // the closing assistant message of a turn: bright answer bar
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
	textarea textarea.Model
	spinner  spinner.Model

	// inputHistory is the chat input's ↑/↓ recall buffer, seeded from
	// the session transcript and banked on every submit. inputPos
	// indexes it — == len means "not navigating". inputDraft holds the
	// half-typed text from when ↑ interrupted it, restored by ↓ past
	// the newest entry.
	inputHistory []string
	inputPos     int
	inputDraft   string

	// messages holds the chat blocks. Blocks up to the printed
	// watermark have been handed to the terminal's real scrollback via
	// tea.Println (flush) and are never redrawn; the live region renders
	// only what is after it — the in-flight streaming turn.
	messages []uiMessage

	// scroll is how many viewport rows the user has scrolled back from
	// the live edge with the wheel; 0 is the live edge. Any submit or
	// incoming stream event snaps back to it.
	scroll int

	// permScroll is the open approval dialog's body scroll offset
	// (plans and previews render in a windowed, scrollable view); 0 is
	// the top. It resets whenever a new question opens the dialog.
	permScroll int

	// permDragging marks a thumb grab on the dialog's scrollbar, with
	// the row the pointer started at inside the thumb.
	permDragging bool
	permGrabOff  int

	picker      *picker      // session chooser overlay; nil when closed
	modelPick   *modelPick   // /model chooser overlay; nil when closed
	settings    *settings    // configuration overlay; nil when closed
	toolsPanel  *toolsPanel  // /tools overlay; nil when closed
	mcpPanel    *mcpPanel    // /mcp overlay; nil when closed
	welcome     *welcome     // first-run walkthrough; nil when closed
	popup       *cmdPopup    // slash-command completion above the input; nil when hidden
	modePick    *modePicker  // /mode chooser above the input; nil when closed
	deviceLogin *deviceLogin // /login khateway device sign-in; nil when closed

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

	// retryNote explains an in-flight retry on the status line ("retry
	// 2/5 · 504 …"); empty except between a RetryEvent and the next one.
	retryNote string

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
	// v2 sizes the box itself: it grows and shrinks with the content
	// between minInputHeight and maxInputHeight rows, scrolling
	// internally beyond the cap. MaxContentHeight is pushed out of the
	// way because v2 would otherwise block input once MaxHeight
	// logical lines are reached; v1 never blocked.
	ta.DynamicHeight = true
	ta.MinHeight = minInputHeight
	ta.MaxHeight = maxInputHeight
	ta.MaxContentHeight = 10_000
	// The defaults paint the focused cursor line with a hard background,
	// which renders as a strip inside the input box on dark terminal
	// themes; drop it so the line keeps the theme's colors.
	styles := textarea.DefaultDarkStyles()
	styles.Focused.CursorLine = lipgloss.NewStyle()
	styles.Blurred.CursorLine = lipgloss.NewStyle()
	promptStyle := lipgloss.NewStyle().Foreground(colGreen)
	styles.Focused.Prompt = promptStyle
	styles.Blurred.Prompt = promptStyle
	phStyle := lipgloss.NewStyle().Foreground(colDim)
	styles.Focused.Placeholder = phStyle
	styles.Blurred.Placeholder = phStyle
	ta.SetStyles(styles)

	sp := spinner.New(spinner.WithSpinner(spinner.MiniDot))
	sp.Style = lipgloss.NewStyle().Foreground(colCyan)
	// Plain enter stays khode's submit (Update handles it before the
	// textarea ever sees it), so the newline binding carries only the
	// modified enters. v2 speaks the kitty keyboard protocol, so
	// shift+enter arrives as a real key on protocol terminals (iTerm2,
	// kitty, Ghostty, WezTerm); alt+enter covers the rest.
	ta.KeyMap.InsertNewline = key.NewBinding(
		key.WithKeys("shift+enter", "alt+enter"),
		key.WithHelp("shift+enter", "newline"),
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

	m.replayTranscript(sess)
	return m
}

// replayTranscript turns a session's messages into chat blocks — the
// same shape the live turn renders, so a resumed conversation prints
// into scrollback exactly as it looked when it happened.
func (m *Model) replayTranscript(sess *agent.Session) {
	msgs := sess.Messages()
	for idx, msg := range msgs {
		final := isFinalAnswer(msgs, idx)
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
				m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true, final: final})
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
				m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true, final: final})
			}
		}
	}
	m.seedInputHistory(msgs)
}

// isFinalAnswer reports whether msgs[idx] is the closing assistant
// message of its turn: assistant prose with no pending tool calls,
// followed by the next user message or ending the transcript cleanly.
func isFinalAnswer(msgs []llm.Message, idx int) bool {
	msg := msgs[idx]
	if msg.Role != llm.RoleAssistant || msg.Content == "" || len(msg.ToolCalls) > 0 {
		return false
	}
	return idx+1 >= len(msgs) || msgs[idx+1].Role == llm.RoleUser
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
// provider: every provider needs a resolvable API key — khateway
// included, since the gateway rejects requests without a client key
// (sign in with /login or store one) — so a turn isn't started just to
// fail with 401.
func (m *Model) hasCredentials() bool {
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
// The transcript replays into unprinted blocks so the next flush prints
// the header plus the whole prior conversation into scrollback (picked
// sessions show their history from now on). The context estimate resets
// with it: the new transcript is empty until the first usage report
// comes back.
func (m *Model) useSession(sess *agent.Session) {
	m.session = sess
	m.ctxIn, m.ctxOut = 0, 0
	m.messages = nil
	m.replayTranscript(sess)
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
	return m.update(msg)
}

func (m Model) update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		first := m.width == 0
		m.width = msg.Width
		m.height = msg.Height
		m.textarea.SetWidth(max(10, m.width-4))
		m.invalidateRendered()
		if first {
			// Width is known for the first time: the banner and any
			// restored transcript print into scrollback now, wrapped to
			// the real terminal.
			return m, m.flush()
		}
		return m, nil

	case tea.PasteMsg:
		// Bracketed paste: v2 enables it by default, and multi-line
		// pastes arrive as one message instead of a rune flood.
		var cmd tea.Cmd
		m.textarea, cmd = m.textarea.Update(msg)
		return m, cmd

	case spinner.TickMsg:
		var cmd tea.Cmd
		m.spinner, cmd = m.spinner.Update(msg)
		return m, cmd

	case streamEventMsg:
		m.scroll = 0
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
		return m, m.flush()

	case permRequestMsg:
		if !m.streaming || m.events == nil {
			// Stale question from a turn that already ended: decline on
			// the user's behalf so nothing blocks.
			msg.req.Answer(false)
			return m, nil
		}
		m.perm = &msg.req
		m.permScroll = 0
		m.permDragging = false
		return m, nil // dialog open; the pump resumes when it is answered

	case mcpApplyMsg:
		m.applyMCPResult(msg)
		return m, m.flush() // the reconciliation notice prints to scrollback

	case modelsFetchedMsg:
		m.applyFetchedModels(msg)
		return m, nil

	case deviceCodeMsg:
		if m.deviceLogin == nil {
			return m, nil // dialog closed while minting — drop it
		}
		return m, m.applyDeviceCode(msg)

	case devicePollTickMsg:
		if m.deviceLogin == nil || m.deviceLogin.code.DeviceCode == "" {
			return m, nil // closed or still minting — the loop dies here
		}
		return m, m.pollDeviceCmd()

	case devicePollResultMsg:
		if m.deviceLogin == nil {
			return m, nil // canceled mid-poll — drop the result
		}
		return m, m.applyDevicePoll(msg)

	case khatewayModelMsg:
		return m, m.applyKhatewayModel(msg)

	// The mouse is captured for the wheel and for clicks
	// (MouseModeCellMotion in View): without it, terminals like iTerm2
	// scroll their own scrollback out from under the alt buffer and the
	// app never sees the tick. The wheel scrolls the conversation, or
	// the open dialog's body; clicks press the chips and rows the
	// renderers registered, and drive the approval dialog's scrollbar.
	// Text selection still works through the terminal's override
	// (shift-drag, option-drag in iTerm2).
	case tea.MouseWheelMsg:
		switch msg.Button {
		case tea.MouseWheelUp:
			if m.perm != nil {
				m.scrollPerm(-wheelStep)
			} else {
				m.scroll += wheelStep
			}
		case tea.MouseWheelDown:
			if m.perm != nil {
				m.scrollPerm(wheelStep)
			} else {
				m.scroll = max(0, m.scroll-wheelStep)
			}
		}
		return m, nil

	case tea.MouseClickMsg:
		if m.mousePermClick(msg) {
			return m, nil // the dialog's scrollbar gutter consumed it
		}
		return m.mouseClicked(msg)

	case tea.MouseMotionMsg:
		m.mousePermDrag(msg)
		return m, nil

	case tea.MouseReleaseMsg:
		m.permDragging = false
		return m, nil

	// Key releases are ignored outright: only presses drive the app.
	case tea.KeyPressMsg:
		return m.handleKey(msg)

	}
	return m, nil
}

// handleKey routes one key press through the overlay precedence chain
// and the base chat bindings. Clicks on keycap chips and list rows
// synthesize keypresses into here, so a button and its key can never
// drift apart.
func (m Model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	if m.perm != nil {
		return m, m.permKey(msg)
	}
	// The sign-in dialog tops every surface it can be opened from —
	// /login in chat, the walkthrough's khateway step, the settings
	// key choice — so it is answered before them; otherwise welcome
	// would eat esc and close the whole walkthrough mid-sign-in.
	if m.deviceLogin != nil {
		return m, m.deviceLoginKey(msg)
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
	if m.mcpPanel != nil {
		return m, m.mcpPanelKey(msg)
	}
	if m.picker != nil {
		return m, m.pickerKey(msg)
	}
	if m.modelPick != nil {
		return m, m.modelPickKey(msg)
	}
	if m.modePick != nil {
		// The mode picker answers first; keys it skips fall through,
		// so ctrl+c still reaches the base switch below.
		if cmd, done := m.modePickKey(msg); done {
			return m, cmd
		}
	}
	if m.popup != nil {
		// The completion list answers first; keys it skips fall
		// through to the textarea below.
		if cmd, done := m.popupKey(msg); done {
			return m, cmd
		}
	}
	switch {
	case msg.String() == "ctrl+c":
		m.stopStream()
		return m, tea.Quit
	case msg.String() == "esc" && m.streaming:
		m.stopStream()
		return m, nil
	// Exactly plain enter submits; modified enters ("shift+enter",
	// "alt+enter") fall through to the textarea, whose InsertNewline
	// binding turns them into newlines.
	case msg.String() == "enter":
		if m.streaming {
			return m, nil
		}
		return m, m.submit()
	// shift+tab walks the permission modes. It only lands here when
	// no overlay is open — welcome and settings use it for their own
	// navigation — and it applies to the in-flight turn immediately:
	// the loop re-reads the mode before every tool call, and a
	// pending dialog auto-approves when the new mode allows it.
	case msg.String() == "shift+tab":
		m.cycleMode()
		return m, nil
	// pgup/pgdn page the conversation viewport (the wheel scrolls it
	// too — see the MouseWheelMsg case).
	case msg.String() == "pgup":
		m.scroll += max(1, m.height-6)
		return m, nil
	case msg.String() == "pgdown":
		m.scroll = max(0, m.scroll-max(1, m.height-6))
		return m, nil
	// ↑/↓ recall prompts from the input history — but only when the
	// cursor already sits on the input's first/last line, so a
	// multi-line draft still moves the cursor between its lines.
	// Overlays above (completion popup, mode picker) answer first.
	case msg.String() == "up" && m.inputHistoryUp():
		return m, textarea.Blink
	case msg.String() == "down" && m.inputHistoryDown():
		return m, textarea.Blink
	}
	// The wheel is captured and swallowed (see View); every other
	// key reaches the textarea.
	var cmd tea.Cmd
	m.textarea, cmd = m.textarea.Update(msg)
	m.syncPopup()
	return m, cmd
}

func (m Model) View() tea.View {
	resetRegions() // this frame's click targets; the renderers fill it
	var content string
	if m.width == 0 {
		content = "starting…"
	} else if m.perm != nil {
		content = m.permView()
	} else if m.deviceLogin != nil {
		// The sign-in dialog renders above whatever opened it (chat,
		// the walkthrough, settings) — matching the key dispatch.
		content = m.deviceLoginView()
	} else if m.welcome != nil {
		content = m.welcomeView()
	} else if m.settings != nil {
		content = m.settingsView()
	} else if m.toolsPanel != nil {
		content = m.toolsView()
	} else if m.mcpPanel != nil {
		content = m.mcpPanelView()
	} else if m.picker != nil {
		content = m.pickerView()
	} else if m.modelPick != nil {
		content = m.modelPickView()
	} else if m.deviceLogin != nil {
		content = m.deviceLoginView()
	} else {
		content = m.chatView()
	}
	// Full screen (alternate buffer), the way Claude Code runs: the
	// whole terminal is repainted every frame, so transient overlays
	// erase cleanly and nothing can leak into scrollback. The mouse is
	// captured for the wheel only: without mouse reporting, terminals
	// like iTerm2 scroll their own scrollback out from under the alt
	// buffer (the wheel would scroll the user out of the TUI) and the
	// app never sees the tick. Text selection survives through the
	// terminal's override — shift-drag in most terminals, option-drag
	// in iTerm2.
	v := tea.NewView(content)
	v.AltScreen = true
	v.MouseMode = tea.MouseModeCellMotion
	return v
}

// hdrChip/stChip are the mode chip's column and width in the header and
// status rows, recorded by their renderers: they know the columns, and
// chatView — the only caller — knows the rows.
var (
	hdrChipX, hdrChipW int
	stChipX, stChipW   int
)

// header renders the sticky frame header: the gradient wordmark and
// provider/model on the left, the session and a permission-mode chip
// on the right, over a quiet rule.
func (m Model) header() string {
	left := logo() +
		dimStyle.Render(fmt.Sprintf("  v%s · %s/%s", Version, m.provider.Name(), m.modelLabel()))
	chip := modeChip.Render(string(m.mode()))
	right := dimStyle.Render(clip(m.session.Name(), 24)) + " " + chip
	hdrChipW = 0
	gap := m.width - lipgloss.Width(left) - lipgloss.Width(right)
	if gap < 2 {
		right = ""
		gap = m.width - lipgloss.Width(left)
		if gap < 0 {
			gap = 0
		}
	} else {
		hdrChipX = lipgloss.Width(left) + gap + lipgloss.Width(right) - lipgloss.Width(chip)
		hdrChipW = lipgloss.Width(chip)
	}
	rule := lipgloss.NewStyle().Foreground(colBorder).Render(strings.Repeat("─", max(0, m.width)))
	return left + strings.Repeat(" ", gap) + right + "\n" + rule
}

// setupHint renders the chat frame's persistent setup banner: while a
// turn would be stopped by the pre-flight — no resolvable key, or a
// provider with no model — the frame says so and points at the way out
// (/welcome, /login, /settings), each command clickable. Esc-skipping
// the walkthrough is allowed, but it must never land in a silently dead
// chat. The regions come back with y relative to the banner's top row;
// chatView knows that row.
func (m *Model) setupHint() (string, []region) {
	var text string
	var rel []region
	hint := func(cmd string, idx int) {
		if i := strings.Index(text, cmd); i >= 0 {
			rel = append(rel, region{x: i, w: len(cmd), kind: clickHintCmd, idx: idx})
		}
	}
	switch {
	case !m.hasCredentials():
		if strings.EqualFold(m.cfg.Provider, llm.ProviderKhateway) {
			text = "khateway not set up · /welcome to finish · /login signs in with your browser"
			hint("/welcome", hintWelcome)
			hint("/login", hintLogin)
		} else {
			text = fmt.Sprintf("no API key for %s · /welcome to finish · /settings → api key", m.cfg.Provider)
			hint("/welcome", hintWelcome)
			hint("/settings", hintSettings)
		}
	case m.cfg.Model() == "":
		text = fmt.Sprintf("no model set for %s · /settings → model picks one (f fetches the list)", m.cfg.Provider)
		hint("/settings", hintSettings)
	default:
		return "", nil
	}
	// One physical row: a wrapped hint would push the frame past the
	// terminal height (same law as modeHint).
	return warnStyle.Render(clip(text, m.width)), rel
}

// chatView assembles the full screen, spanning the terminal's whole
// height: the khode header pinned to the top rows, the command hints
// under it, the conversation viewport filling the middle, and the
// status + input block pinned to the bottom edge. Everything is in the
// frame, so overlays erase cleanly on close.
func (m Model) chatView() string {
	status := m.statusLine()
	border := inputBorder
	if m.streaming {
		border = inputBorderLive // the frame answers the stream in kind
	}
	inputBox := border.Render(m.textarea.View())
	help := m.helpLine()

	// The middle stack between the conversation and the input. Bands
	// carry their click regions with y relative to the band's top row,
	// because their absolute rows are only known once the whole stack's
	// height has gone into the frame budget.
	type midBand struct {
		view string
		rel  []region
	}
	var mid []midBand
	if hint, rel := m.setupHint(); hint != "" {
		mid = append(mid, midBand{hint, rel}) // setup banner: first, persistent
	}
	if m.popup != nil {
		view, rel := m.popupView() // floats just above the input
		mid = append(mid, midBand{view, rel})
	}
	if hint := m.modeHint(); hint != "" {
		// The whole reminder line cycles the mode, as its tail says.
		rel := []region{{x: 0, w: m.width, kind: clickKey, key: keyPress("shift+tab")}}
		mid = append(mid, midBand{hint, rel})
	}
	if m.modePick != nil {
		view, rel := m.modePickView() // floats just above the input
		mid = append(mid, midBand{view, rel})
	}

	// The budget counts rendered rows, not bands: the popup and the
	// mode picker are multi-row, and a short count here would push the
	// frame past the terminal and clip the header.
	midRows := 0
	for _, band := range mid {
		midRows += lipgloss.Height(band.view)
	}

	header := m.header()
	hints := dimStyle.Render(" · /help commands · /settings config")
	chrome := 3 + 1 + midRows + m.textarea.Height() + 2 + 1 // header 2, hints, status, mid, input, help
	vrows := max(1, m.height-chrome)

	// The viewport fills the middle; a conversation shorter than it
	// pads above, the way a full-height layout leaves the middle open.
	vlines := strings.Split(
		viewportStyle.Width(m.width).Render(m.messageViewport(vrows)), "\n")
	for len(vlines) < vrows {
		vlines = append([]string{""}, vlines...)
	}

	// Click targets for the frame: the two mode chips (their columns
	// were recorded by the renderers) and the middle stack, which sits
	// right above the status line.
	midTop := m.height - (m.textarea.Height() + 2) - 1 - midRows
	if hdrChipW > 0 {
		addRegion(region{x: hdrChipX, y: 0, w: hdrChipW, kind: clickModeChip})
	}
	if stChipW > 0 {
		addRegion(region{x: stChipX, y: midTop - 1, w: stChipW, kind: clickModeChip})
	}
	y := midTop
	for _, band := range mid {
		for _, r := range band.rel {
			r.y += y
			addRegion(r)
		}
		y += lipgloss.Height(band.view)
	}
	// The input box: one full-width region per inner row, so a press
	// places the textarea cursor where the click landed (input.go).
	inputTop := m.height - 1 - (m.textarea.Height() + 2)
	for r := 0; r < m.textarea.Height(); r++ {
		addRegion(region{x: 1, y: inputTop + 1 + r, w: m.width - 2, kind: clickInput, idx: r})
	}

	parts := append(strings.Split(header, "\n"), hints)
	parts = append(parts, vlines...)
	parts = append(parts, status)
	for _, band := range mid {
		parts = append(parts, band.view)
	}
	parts = append(parts, inputBox, help)
	out := strings.Split(lipgloss.JoinVertical(lipgloss.Left, parts...), "\n")
	if len(out) > m.height {
		out = out[len(out)-m.height:]
	}
	for len(out) < m.height {
		out = append(out, "")
	}
	return strings.Join(out, "\n")
}

// messageViewport renders the conversation as viewport rows, ending at
// the live edge unless the user has scrolled back (m.scroll).
func (m Model) messageViewport(rows int) string {
	var blocks []string
	for i := range m.messages {
		blocks = append(blocks, m.block(i, m.printWidth()))
	}
	if streaming := m.streamingBlock(); streaming != "" {
		blocks = append(blocks, streaming)
	}
	var lines []string
	if len(blocks) > 0 {
		lines = strings.Split(strings.Join(blocks, "\n\n"), "\n")
	}
	if len(lines) == 0 {
		return dimStyle.Render("· nothing yet — say hello")
	}
	// A fixed window of exactly `rows` lines, ending `scroll` lines
	// above the live edge: the frame must stay terminal-height, so
	// scrolling slides the window instead of adding rows to it.
	start := len(lines) - rows - m.scroll
	start = max(0, min(start, len(lines)-1))
	end := min(start+rows, len(lines))
	return strings.Join(lines[start:end], "\n")
}

// streamingBlock renders the in-flight turn, if any — blocks marked
// streaming render with the live cursor; sealed ones are plain history.
func (m Model) streamingBlock() string {
	var blocks []string
	for i := range m.messages {
		if m.messages[i].streaming {
			blocks = append(blocks, strings.TrimSpace(m.block(i, m.printWidth())))
		}
	}
	if len(blocks) == 0 {
		return ""
	}
	return strings.Join(blocks, "\n\n")
}

// helpLine renders the bottom key reference: key names faint cyan,
// verbs dim.
func (m Model) helpLine() string {
	hints := []struct{ k, v string }{
		{"enter", "send"},
		{"shift+enter", "newline"},
		{"shift+tab", "mode"},
		{"pgup/pgdn", "history"},
		{"esc", "stop stream"},
		{"ctrl+c", "quit"},
	}
	parts := make([]string, 0, len(hints))
	for _, h := range hints {
		parts = append(parts, helpKey.Render(h.k)+dimStyle.Render(" "+h.v))
	}
	// Drop hints from the end until the line fits: a wrapped help line
	// would spill a lone fragment onto an extra row.
	for len(parts) > 1 && lipgloss.Width(strings.Join(parts, dimStyle.Render(" · ")))+1 > m.width {
		parts = parts[:len(parts)-1]
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
	if _, retry := ev.(llm.RetryEvent); !retry {
		m.retryNote = "" // the stream moved on; the note only explains waiting
	}
	switch e := ev.(type) {
	case llm.ThinkingDeltaEvent:
		sealed := m.ensureStreamingBlock(kindThinking)
		m.partialThink.WriteString(e.Text)
		if idx := len(m.messages) - 1; idx >= 0 && m.messages[idx].streaming {
			m.messages[idx].raw = m.partialThink.String()
		}
		return tea.Batch(m.pump(), m.flushIf(sealed))

	case llm.TextDeltaEvent:
		sealed := m.ensureStreamingBlock(kindText)
		m.partial.WriteString(e.Text)
		if idx := len(m.messages) - 1; idx >= 0 && m.messages[idx].streaming {
			m.messages[idx].raw = m.partial.String()
		}
		return tea.Batch(m.pump(), m.flushIf(sealed))

	case llm.ToolCallEvent:
		m.sealStreamingText()
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleAssistant, kind: kindToolCall, raw: formatToolCall(e.ToolCall),
		})
		return tea.Batch(m.pump(), m.flush())

	case llm.ToolResultEvent:
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleTool, kind: kindToolResult, raw: e.Output, isErr: e.IsError,
			full: e.Name == "todo",
		})
		return tea.Batch(m.pump(), m.flush())

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
		return tea.Batch(m.pump(), m.flush())

	case llm.RetryEvent:
		// The status line explains the wait: "working · 41s · retry 2/5 ·
		// 504 from the gateway" instead of a silent spinner.
		m.retryNote = fmt.Sprintf("retry %d/%d · %s", e.Attempt, e.Max, clip(e.Err.Error(), 60))
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
// seals the old phase, reports it, and appends the new one). A sealed
// block always carries content by the time the stream moves on.
func (m *Model) ensureStreamingBlock(kind uiMessageKind) (sealed bool) {
	if len(m.messages) > 0 {
		last := &m.messages[len(m.messages)-1]
		if last.streaming {
			if last.kind == kind {
				return false
			}
			last.streaming = false
			m.partial.Reset()
			m.partialThink.Reset()
			sealed = true // the old phase can print now
		}
	}
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, kind: kind, streaming: true, history: true})
	return sealed
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

// markFinalAnswer flags the turn's last assistant text block so it
// renders under the bright answer bar. A cached render is dropped: the
// block may already have been drawn with the mid-turn bar. Errors keep
// their turn unmarked — the failure note is the loud end, not the prose.
func (m *Model) markFinalAnswer() {
	for i := len(m.messages) - 1; i >= 0; i-- {
		msg := &m.messages[i]
		if msg.role == llm.RoleAssistant && msg.kind == kindText {
			msg.final = true
			msg.rendered = ""
			return
		}
	}
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
	} else {
		m.markFinalAnswer()
	}

	// The turn is over: its blocks (final answer included) print into
	// the terminal's real scrollback and the live region empties.
	return tea.Batch(m.flush(), textarea.Blink)
}

func (m *Model) stopStream() {
	if m.cancel != nil {
		m.cancel()
	}
}

// --- input handling ----------------------------------------------------------

func (m *Model) submit() tea.Cmd {
	m.scroll = 0
	input := strings.TrimSpace(m.textarea.Value())
	m.textarea.Reset()
	m.closePopup()
	if input == "" {
		return nil
	}
	m.rememberInput(input)
	if strings.HasPrefix(input, "/") {
		return m.command(input)
	}
	if !m.hasCredentials() {
		raw := fmt.Sprintf("no API key for %s · open /settings → api key and paste one (or set %s)",
			m.cfg.Provider, m.cfg.APIKeyEnvName(m.cfg.Provider))
		if strings.EqualFold(m.cfg.Provider, llm.ProviderKhateway) {
			raw = fmt.Sprintf("no khateway key · /login signs in with your browser, or /settings → api key to paste one (or set %s)",
				m.cfg.APIKeyEnvName(m.cfg.Provider))
		}
		m.messages = append(m.messages, uiMessage{role: "system", raw: raw})
		return m.flush()
	}
	if m.cfg.Model() == "" {
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("no model set for %s · open /settings → model (f fetches the list, n adds one)",
				m.cfg.Provider)})
		return m.flush()
	}

	m.messages = append(m.messages, uiMessage{role: llm.RoleUser, raw: input, history: true})
	return tea.Batch(m.flush(), m.startTurn(input))
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
		Mode:      func() perm.Mode { return m.mode() },
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

// cycleMode advances to the next permission mode (shift+tab). It
// persists like setMode but stays quiet: the mode line above the input
// is the feedback, and one notice per press would spam the scrollback
// (the same reasoning as the settings overlay's applyMode).
func (m *Model) cycleMode() {
	m.cfg.PermissionMode = string(perm.Next(m.mode()))
	if err := m.cfg.Save(); err != nil {
		m.lastErr = err.Error()
	}
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
		Mode:      func() perm.Mode { return m.mode() },
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

	case "/welcome":
		// Re-run the first-run walkthrough on demand: esc only
		// dismisses it for the session, so this is the way back in
		// once any setup step has persisted something.
		m.OpenWelcome()

	case "/mode":
		if len(parts) < 2 {
			m.openModePicker()
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
		m.openMCPPanel()

	case "/login":
		return m.openDeviceLogin()

	case "/compact":
		if m.streaming {
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: "wait for the current turn to finish, then /compact"})
			break
		}
		if !m.hasCredentials() {
			raw := fmt.Sprintf("no API key for %s · compaction needs one · see /settings",
				m.cfg.Provider)
			if strings.EqualFold(m.cfg.Provider, llm.ProviderKhateway) {
				raw = "no khateway key · compaction needs one · /login signs in, or see /settings"
			}
			m.messages = append(m.messages, uiMessage{role: "system", raw: raw})
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
			return m.openModelPick()
		}
		m.cfg.SetModel(parts[1])
		if err := m.cfg.Save(); err != nil {
			m.lastErr = err.Error()
		}
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("model → %s/%s", m.provider.Name(), m.cfg.Model())})

	case "/exit", "/quit":
		return tea.Quit

	default:
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("unknown command %s · try /help", parts[0])})
	}
	return m.flush()
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
			dimStyle.Render(" · "+elapsed.String())
		if m.retryNote != "" {
			state += warnStyle.Render(" · " + clip(m.retryNote, max(20, m.width/2)))
		}
		state += dimStyle.Render(" · esc to stop")
	case m.lastErr != "":
		state = errorStyle.Render("✗ " + clip(m.lastErr, max(20, m.width/2)))
	default:
		state = okStyle.Render("● ready")
		if m.lastTurn > 0 {
			state += dimStyle.Render(" · last turn " + m.lastTurn.Truncate(time.Second).String())
		}
	}
	// The header moved into the scrollback banner, so the status line
	// carries the mode and model live. On narrow terminals it yields the
	// model name first, then the token counts — mode, context, and cost
	// stay put.
	sep := dimStyle.Render(" · ")
	usage := []string{}
	if c := m.ctxLabel(); c != "" {
		usage = append(usage, c)
	}
	usage = append(usage, dimStyle.Render(m.costLabel()))
	build := func(withModel, withTok bool) string {
		segs := []string{modeChip.Render(string(m.mode()))}
		if withModel {
			segs = append(segs, dimStyle.Render(clip(m.modelLabel(), 24)))
		}
		if withTok {
			segs = append(segs, dimStyle.Render(fmt.Sprintf("in %s · out %s",
				humanTokens(m.inTokens), humanTokens(m.outTokens))))
		}
		return strings.Join(append(segs, usage...), sep)
	}

	right := build(true, true)
	if m.width-lipgloss.Width(state)-lipgloss.Width(right) < 1 {
		right = build(false, true)
	}
	if m.width-lipgloss.Width(state)-lipgloss.Width(right) < 1 {
		right = build(false, false)
	}
	gap := max(1, m.width-lipgloss.Width(state)-lipgloss.Width(right))
	// The chip leads `right` in every fallback, so its column is where
	// the right group starts; the region is registered by chatView,
	// which knows the status row.
	stChipX = lipgloss.Width(state) + gap
	stChipW = lipgloss.Width(modeChip.Render(string(m.mode())))
	return state + strings.Repeat(" ", gap) + right
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
		// User input rides the green bar: khode's answer-bar grammar in
		// the palette's user color, wrapped to the chat width with a
		// hanging indent under the ❯. No filled band — backgrounds are
		// where terminal color degradation bites.
		wrapped := wordwrap.String(msg.raw, width-4)
		wlines := strings.Split(wrapped, "\n")
		for i, l := range wlines {
			wlines[i] = clip(l, width-2)
		}
		out = userBar.Width(width).Render(userMark.Render("❯ ") + strings.Join(wlines, "\n  "))
	case msg.role == llm.RoleAssistant:
		if msg.streaming {
			// Live text rides the same markdown pipeline, re-run per
			// delta; the cursor trails the last line until the block
			// seals into the plain answer-bar view.
			out = answerBar.Width(width).Render(renderMarkdown(msg.raw, width-answerBarOverhead)) +
				streamCursor.Render("▌")
		} else {
			// Sealed prose rides the answer bar: bright cyan on the
			// turn's final message, dim teal on mid-turn text.
			bar := answerBar
			if msg.final {
				bar = answerBarFinal
			}
			out = bar.Width(width).Render(renderMarkdown(msg.raw, width-answerBarOverhead))
		}
	default:
		out = systemStyle.Width(width).Render("· " + msg.raw)
	}

	// Streaming blocks re-render every frame as their raw grows, so
	// they never populate the cache: sealing (streaming → false) must
	// fall through to the sealed path instead of replaying a
	// cursor-trailed body.
	if !msg.streaming {
		msg.rendered = out
		m.messages[i] = msg
	}
	return out
}

// printWidth is the wrap width of chat blocks: the terminal width minus
// the live region's one-column side padding.
func (m Model) printWidth() int { return m.width - 2 }

// flush is a compatibility no-op: the conversation renders inside the
// full-screen frame (see messageViewport), so sealing a block needs no
// scrollback printing. It remains because a handful of call sites use
// it as the "something sealed" hook.
func (m *Model) flush() tea.Cmd {
	return nil
}

// flushIf flushes only when a seal actually happened, saving an empty
// command on every streaming delta.
func (m *Model) flushIf(sealed bool) tea.Cmd {
	if !sealed {
		return nil
	}
	return m.flush()
}

func (m *Model) invalidateRendered() {
	for i := range m.messages {
		m.messages[i].rendered = ""
	}
}

// --- helpers -----------------------------------------------------------------

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
