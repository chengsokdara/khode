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
	"math"
	"regexp"
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
	kindTodo // the agent's live task checklist panel
	kindDiff // an edit/write call's change, rendered git-style
	// kindContext is a replayed <task-context> preface: the dim,
	// collapsible context brief a gatherer wrote ahead of the turn.
	kindContext
	// kindGather is the in-flight first-prompt context gatherer; on
	// completion it turns into a kindContext block (or is removed).
	kindGather
)

// uiMessage is a message shown in the chat pane. Only messages with
// history=true mirror the session transcript; tool blocks display agent
// activity and are display-only.
type uiMessage struct {
	role      llm.Role
	kind      uiMessageKind
	raw       string
	diff      string // kindDiff only: the call's plain unified diff text
	path      string // kindDiff only: the file the diff is for (lexer pick)
	rendered  string
	streaming bool
	isErr     bool
	expanded  bool // truncated results and diffs: ctrl+o/click reveals all
	final     bool // the closing assistant message of a turn: bright answer bar
	history   bool
	// subLine is the in-flight subagent's live activity under a task
	// call line ("explore · read loop.go · 3 calls"); cleared when the
	// task's result lands.
	subLine string
}

// diffChange is a write-class call's change, banked at call time and
// paired with its result through the call id.
type diffChange struct {
	path string
	diff string
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

	// queued holds prompts typed while a turn was streaming: enter
	// files one instead of submitting, the queued band shows the head
	// of the line, and finishStream auto-submits them FIFO at turn end
	// (esc restores them to the textarea instead). UI state only — the
	// agent loop never sees a queued prompt until it is actually sent.
	queued []string

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
	agentsPanel *agentsPanel // /agents overlay; nil when closed
	welcome     *welcome     // first-run walkthrough; nil when closed
	popup       *cmdPopup    // slash-command completion above the input; nil when hidden
	modePick    *modePicker  // /mode chooser above the input; nil when closed
	deviceLogin *deviceLogin // /login khateway device sign-in; nil when closed

	streaming bool
	cancel    context.CancelFunc
	events    <-chan llm.Event
	// phase is what the in-flight turn is doing right now ("thinking",
	// "responding", or the running tool's name): it drives the status
	// line's live verb and the breathing glyph. "" means between phases
	// — "working".
	phase string
	// partial accumulates the in-flight reply and partialThink the
	// in-flight thinking. Both are pointers because Model is copied by
	// value through Update; a value Builder would trip its
	// copied-by-value check whenever the escape analyzer chooses not to
	// alias the copies.
	partial      *strings.Builder
	partialThink *strings.Builder

	// diffCalls remembers the change diff of in-flight edit/write calls
	// by call id: the result event carries only the summary line, so the
	// git-style block pairs it with the diff computed at call time.
	diffCalls map[string]diffChange

	// taskProgress carries one-line subagent activity from the task
	// tool's Exec (running on agent goroutines) into Update; the sender
	// drops lines rather than block the child. activeTasks maps each
	// in-flight task's parent call id to its call block index — parallel
	// read-only children (an explore fan-out) run side by side, each
	// upserting its own nested line.
	taskProgress chan agent.SubagentProgress
	activeTasks  map[string]int

	// gather holds the first-prompt context-gatherer phase: on a fresh
	// session the UI runs a read-only subagent before the first real
	// turn and injects its brief as the main runner's Preface. While
	// gathering, streamEventMsg routes to the gather handler; the block
	// it renders becomes the durable context-brief block (or a note)
	// when the phase ends.
	gathering   bool
	gatherIdx   int              // the in-flight gather block, -1 when none
	gatherText  *strings.Builder // the brief as it streams in
	gatherInput string           // the user prompt the brief is for

	// todoNow is the agent's current todo item with done/total counts,
	// mirrored from the todo tool so the status line can show live
	// progress while a turn runs.
	todoNow   string
	todoDone  int
	todoTotal int

	// ctxIn/ctxOut are the most recent request's usage: ctxIn is the
	// transcript size the provider saw, so the status line can render
	// how full the model's context window is.
	ctxIn  int64
	ctxOut int64

	// mcpClients holds the running MCP server connections so /settings
	// can start and stop servers live. mcpEvents carries server names
	// whose tools/list_changed notification arrived (sent by the clients'
	// notify hooks, dropped when full); the pump drains it into a
	// re-list, so while the app idles the pings simply queue for the
	// next armed pump.
	mcpClients map[string]*mcp.Client
	mcpEvents  chan string

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
		mcpEvents:    make(chan string, 8),
		workdir:      workdir,
		textarea:     ta,
		spinner:      sp,
		partial:      new(strings.Builder),
		partialThink: new(strings.Builder),
		approvals:    agent.NewBridge(),
		taskProgress: make(chan agent.SubagentProgress, 64),
	}

	// Startup MCP clients report tool-list changes into the pump's
	// channel; clients started later get the same hook when the
	// reconcile installs them.
	for name, cli := range mcpClients {
		cli.SetNotify(mcpNotifyFunc(m.mcpEvents, name))
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
	// todoCalls remembers parsed todo-call inputs by call id: a round's
	// results can interleave with other tools' results, so pairing goes
	// through the id, not transcript adjacency. diffCalls does the same
	// for write-class calls, whose results replay as git-style diffs.
	todoCalls := map[string][]tools.Todo{}
	diffCalls := map[string]diffChange{}
	for idx, msg := range msgs {
		final := isFinalAnswer(msgs, idx)
		switch {
		case msg.Role == llm.RoleTool && msg.ToolResult != nil:
			if items, isTodo := todoCalls[msg.ToolResult.CallID]; isTodo {
				delete(todoCalls, msg.ToolResult.CallID)
				if items == nil {
					items = parseTodoRender(msg.ToolResult.Content)
				}
				m.upsertTodoPanel(items)
			} else if d, isDiff := diffCalls[msg.ToolResult.CallID]; isDiff {
				delete(diffCalls, msg.ToolResult.CallID)
				if msg.ToolResult.IsError {
					m.messages = append(m.messages, uiMessage{
						role: msg.Role, kind: kindToolResult, raw: msg.ToolResult.Content,
						isErr: true, history: true,
					})
				} else {
					m.messages = append(m.messages, uiMessage{
						role: msg.Role, kind: kindDiff, raw: msg.ToolResult.Content,
						diff: d.diff, path: d.path, history: true,
					})
				}
			} else {
				m.messages = append(m.messages, uiMessage{
					role:    msg.Role,
					kind:    kindToolResult,
					raw:     msg.ToolResult.Content,
					isErr:   msg.ToolResult.IsError,
					history: true,
				})
			}
		case msg.Role == llm.RoleAssistant && len(msg.ToolCalls) > 0:
			if msg.Thinking != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, kind: kindThinking, raw: msg.Thinking, history: true})
			}
			if msg.Content != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true, final: final})
			}
			for _, c := range msg.ToolCalls {
				if c.Name == "todo" {
					// The checklist panel renders todo updates; the call
					// line would only repeat the list as JSON.
					todoCalls[c.ID] = parseTodoInput(c.Input)
					continue
				}
				if d := tools.ChangeDiff(c.Name, c.Input); d != "" {
					diffCalls[c.ID] = diffChange{path: writeToolPath(c.Name, c.Input), diff: d}
				}
				m.messages = append(m.messages, uiMessage{
					role: msg.Role, kind: kindToolCall, raw: formatToolCall(c), history: true,
				})
			}
		default:
			if strings.HasPrefix(msg.Content, "<task-context>") {
				// A gatherer's context brief, written ahead of the user
				// turn: renders as a dim collapsed block instead of a
				// user bubble.
				m.messages = append(m.messages, uiMessage{
					role: msg.Role, kind: kindContext, raw: msg.Content, history: true,
				})
				continue
			}
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
		Provider:        m.provider,
		Workdir:         m.workdir,
		Model:           m.cfg.Model,
		SubModel:        m.cfg.SubModel,
		MaxTokens:       func() int { return m.cfg.MaxTokens },
		ReasoningEffort: func() string { return m.cfg.ReasoningEffortValue() },
		Mode:            modeFn,
		Approver:        m.approvals,
		ToolSource:      func() *tools.Registry { return m.tools },
		Hooks:           func() *hooks.Runner { return hooks.New(m.cfg.Hooks, m.workdir) },
		Progress: func(p agent.SubagentProgress) {
			// Best-effort feed: drop a line rather than stall the child.
			select {
			case m.taskProgress <- p:
			default:
			}
		},
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
	m.todoNow, m.todoDone, m.todoTotal = "", 0, 0
	m.queued = nil // a session switch must not inherit queued prompts
}

// --- tea.Model -------------------------------------------------------------

type streamEventMsg struct{ ev llm.Event }

// streamClosedMsg arrives when the provider closed the event channel without
// a terminal event (e.g. ctx cancelled before we drained it).
type streamClosedMsg struct{}

// taskProgressMsg is one line of a running subagent's activity, taken
// from the taskProgress channel.
type taskProgressMsg agent.SubagentProgress

// mcpChangedMsg names an MCP server whose tools/list_changed
// notification arrived, taken from the mcpEvents channel.
type mcpChangedMsg string

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
		// A close only means something while a turn is live; after the
		// drain a stale close must not clobber the queued turn that
		// finishStream just started.
		if m.streaming {
			return m, m.finishStream()
		}
		return m, nil

	case taskProgressMsg:
		idx, ok := m.activeTasks[msg.CallID]
		if !ok || idx < 0 || idx >= len(m.messages) {
			return m, m.pump()
		}
		blk := m.messages[idx]
		blk.subLine = fmt.Sprintf("%s · %s · %d calls", msg.Kind, msg.Activity, msg.Calls)
		blk.rendered = "" // drop the block cache so the line re-renders
		m.messages[idx] = blk
		return m, m.pump()

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

	case mcpChangedMsg:
		return m, m.startMCPRefresh(string(msg))

	case mcpRefreshMsg:
		m.applyMCPRefresh(msg)
		return m, m.flush()

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
	if m.agentsPanel != nil {
		return m, m.agentsKey(msg)
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
		// An interrupt cancels the plan: prompts held for this turn go
		// back to the input instead of auto-submitting behind the
		// user's back.
		if len(m.queued) > 0 {
			m.textarea.SetValue(strings.Join(m.queued, "\n\n"))
			m.textarea.MoveToEnd()
			m.queued = nil
		}
		return m, nil
	// Exactly plain enter submits; modified enters ("shift+enter",
	// "alt+enter") fall through to the textarea, whose InsertNewline
	// binding turns them into newlines. While a turn streams, submit
	// files the prompt instead of racing the turn (see submit).
	case msg.String() == "enter":
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
	// ctrl+o expands the most recent truncated block — a tool result's
	// full output or a capped diff — and collapses it again.
	case msg.String() == "ctrl+o":
		m.toggleExpand()
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
	} else if m.agentsPanel != nil {
		content = m.agentsView()
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
	rule := m.headerRule()
	return left + strings.Repeat(" ", gap) + right + "\n" + rule
}

// headerRule is the header's horizontal rule: quiet border teal while
// the app is idle; while a turn runs, a bright band travels along it on
// the breath clock (the same wall-clock phase the status mark, cursor,
// and input border ride — no extra tick machinery).
func (m Model) headerRule() string {
	w := max(0, m.width)
	if !m.streaming || w == 0 {
		return lipgloss.NewStyle().Foreground(colBorder).Render(strings.Repeat("─", w))
	}
	travel := math.Mod(float64(m.breathElapsed())/float64(breathPeriod), 1)
	var b strings.Builder
	for i := 0; i < w; i++ {
		b.WriteString(lipgloss.NewStyle().
			Foreground(shimmerColor(float64(i)/float64(w), travel)).Render("─"))
	}
	return b.String()
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

// queuedHint renders the band above the input while prompts are held for
// the in-flight turn: the head of the line, plus how many more wait
// behind it. Quiet by design — the turn keeps center stage; the queued
// prompt is what happens next, not an alarm. One physical row, like the
// setup banner.
func (m *Model) queuedHint() string {
	if len(m.queued) == 0 {
		return ""
	}
	text := m.icons().queued + " next: " + firstLine(m.queued[0])
	if extra := len(m.queued) - 1; extra > 0 {
		text += fmt.Sprintf(" · +%d queued", extra)
	}
	return dimStyle.Render(clip(text, m.width))
}

// firstLine flattens a multi-line prompt to its opening line for the
// queued band.
func firstLine(s string) string {
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		return s[:i]
	}
	return s
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
		// The frame answers the stream in kind, breathing with it.
		border = inputBorderLive.BorderForeground(breathColor(m.breathElapsed()))
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
	if hint := m.queuedHint(); hint != "" {
		mid = append(mid, midBand{hint, nil}) // prompts held for the running turn
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
	viewport, lineOf := m.messageViewport(vrows)
	vlines := strings.Split(viewportStyle.Width(m.width).Render(viewport), "\n")
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
	// Expandable blocks in the viewport register one full-width region
	// per visible line: a press anywhere on the block toggles its
	// detail. The window's pad lines sit above the conversation lines.
	vtop := midTop - vrows
	pad := len(vlines) - len(lineOf)
	for i, mi := range lineOf {
		if mi >= 0 && expandable(m.messages[mi]) {
			addRegion(region{x: 0, y: vtop + pad + i, w: m.width, kind: clickExpand, idx: mi})
		}
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
// the live edge unless the user has scrolled back (m.scroll). Beside
// the joined lines it returns, per line, the index of the message the
// line belongs to (-1 for separators and filler) so chatView can
// register the frame's click regions on expandable blocks.
func (m Model) messageViewport(rows int) (string, []int) {
	var lines []string
	lineOf := make([]int, 0, len(m.messages))
	appendBlock := func(i, prev int) {
		if len(lines) > 0 {
			// A tool result hangs directly under its call — the ⎿
			// belongs to the ⏺ above it, not two blank rows away;
			// everything else keeps the two-line breathing room.
			blanks := 2
			if prev >= 0 && resultHugsCall(m.messages[prev], m.messages[i]) {
				blanks = 0
			}
			for range blanks {
				lines = append(lines, "")
				lineOf = append(lineOf, -1)
			}
		}
		for _, l := range strings.Split(m.block(i, m.printWidth()), "\n") {
			lines = append(lines, l)
			lineOf = append(lineOf, i)
		}
	}
	prev := -1
	for i := range m.messages {
		if m.messages[i].streaming {
			continue // the live edge paints these below
		}
		appendBlock(i, prev)
		prev = i
	}
	for i := range m.messages {
		if m.messages[i].streaming {
			appendBlock(i, prev)
			prev = i
		}
	}
	if len(lines) == 0 {
		return dimStyle.Render("· nothing yet — say hello"), []int{-1}
	}
	// A fixed window of exactly `rows` lines, ending `scroll` lines
	// above the live edge: the frame must stay terminal-height, so
	// scrolling slides the window instead of adding rows to it.
	start := len(lines) - rows - m.scroll
	start = max(0, min(start, len(lines)-1))
	end := min(start+rows, len(lines))
	return strings.Join(lines[start:end], "\n"), lineOf[start:end]
}

// resultHugsCall reports whether block cur is the outcome of the tool
// call before it: results and change diffs hang directly under their ⏺
// line, one visual unit, instead of drifting two blank rows away.
func resultHugsCall(prev, cur uiMessage) bool {
	if prev.kind != kindToolCall {
		return false
	}
	return cur.kind == kindToolResult || cur.kind == kindDiff
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
		// Dropped first on narrow terminals: the truncation markers
		// name it where it matters.
		{"ctrl+o", "expand"},
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

// waitForEvents blocks until either the stream produces an event, the
// approval bridge has a question, a subagent reports activity, or an
// MCP server announces a tool-list change; whichever is offered first.
// A nil channel never fires, so callers opt out by passing nil.
func waitForEvents(ch <-chan llm.Event, reqs <-chan agent.Request, prog <-chan agent.SubagentProgress, mcpEv <-chan string) tea.Cmd {
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
		case p := <-prog:
			return taskProgressMsg(p)
		case name := <-mcpEv:
			return mcpChangedMsg(name)
		}
	}
}

// pump schedules the next poll of the stream, the approval bridge, the
// subagent activity feed, and the MCP change feed.
func (m *Model) pump() tea.Cmd {
	return waitForEvents(m.events, m.approvals.Requests(), m.taskProgress, m.mcpEvents)
}

func (m *Model) handleStreamEvent(ev llm.Event) tea.Cmd {
	if m.gathering {
		// The first-prompt context gatherer rides the same stream
		// channel; route to its handler until it hands off to the turn.
		return m.handleGatherEvent(ev)
	}
	if _, retry := ev.(llm.RetryEvent); !retry {
		m.retryNote = "" // the stream moved on; the note only explains waiting
	}
	switch e := ev.(type) {
	case llm.ThinkingDeltaEvent:
		m.phase = "thinking"
		sealed := m.ensureStreamingBlock(kindThinking)
		m.partialThink.WriteString(e.Text)
		if idx := m.streamingIndex(); idx >= 0 {
			m.messages[idx].raw = m.partialThink.String()
		}
		return tea.Batch(m.pump(), m.flushIf(sealed))

	case llm.TextDeltaEvent:
		m.phase = "responding"
		sealed := m.ensureStreamingBlock(kindText)
		m.partial.WriteString(e.Text)
		if idx := m.streamingIndex(); idx >= 0 {
			m.messages[idx].raw = m.partial.String()
		}
		return tea.Batch(m.pump(), m.flushIf(sealed))

	case llm.ToolCallEvent:
		m.phase = e.Name
		m.sealStreamingText()
		if e.Name == "todo" {
			// The checklist panel is the feedback for todo updates; a
			// call line would only echo the whole list back as JSON.
			return tea.Batch(m.pump(), m.flush())
		}
		// Write-class calls bank their change diff now, computed from the
		// input alone; the result event pairs it with the summary line.
		if d := tools.ChangeDiff(e.Name, e.Input); d != "" {
			if m.diffCalls == nil {
				m.diffCalls = make(map[string]diffChange)
			}
			m.diffCalls[e.ID] = diffChange{path: writeToolPath(e.Name, e.Input), diff: d}
		}
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleAssistant, kind: kindToolCall, raw: formatToolCall(e.ToolCall),
		})
		if e.Name == "task" {
			// The child reports through the progress feed while it runs;
			// read-only children may run side by side, so every in-flight
			// call id maps to its own call block.
			if m.activeTasks == nil {
				m.activeTasks = make(map[string]int)
			}
			m.activeTasks[e.ID] = len(m.messages) - 1
		}
		return tea.Batch(m.pump(), m.flush())

	case llm.ToolResultEvent:
		if idx, ok := m.activeTasks[e.CallID]; ok {
			// The report block itself is the finished feedback: drop the
			// live activity line.
			if idx >= 0 && idx < len(m.messages) {
				blk := m.messages[idx]
				blk.subLine = ""
				blk.rendered = ""
				m.messages[idx] = blk
			}
			delete(m.activeTasks, e.CallID)
		}
		if e.Name == "todo" && !e.IsError {
			m.upsertTodoPanel(m.todoList())
			return tea.Batch(m.pump(), m.flush())
		}
		d, hasDiff := m.diffCalls[e.CallID]
		delete(m.diffCalls, e.CallID)
		if hasDiff && !e.IsError {
			// A write-class result renders as its change: the summary
			// line over the highlighted diff, instead of flat output.
			m.messages = append(m.messages, uiMessage{
				role: llm.RoleTool, kind: kindDiff, raw: e.Output, diff: d.diff, path: d.path,
			})
			return tea.Batch(m.pump(), m.flush())
		}
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleTool, kind: kindToolResult, raw: e.Output, isErr: e.IsError,
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
// when no open one matches (turn start, a new round after tool calls,
// or the thinking ↔ answer switch within one round — the switch seals
// the old phase, reports it, and appends the new one). A sealed block
// always carries content by the time the stream moves on; one that
// never said anything is dropped instead of sealing into a stray bar.
func (m *Model) ensureStreamingBlock(kind uiMessageKind) (sealed bool) {
	if idx := m.streamingIndex(); idx >= 0 {
		if m.messages[idx].kind == kind {
			return false
		}
		sealed = true
		if strings.TrimSpace(m.messages[idx].raw) == "" {
			m.messages = append(m.messages[:idx], m.messages[idx+1:]...)
		} else {
			m.messages[idx].streaming = false
		}
	}
	m.partial.Reset()
	m.partialThink.Reset()
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, kind: kind, streaming: true, history: true})
	return sealed
}

// streamingIndex finds the open streaming block — normally the last
// message, but activity appended after it (a todo panel refresh, a
// compaction notice) must not freeze the block's raw updates.
func (m *Model) streamingIndex() int {
	for i := len(m.messages) - 1; i >= 0; i-- {
		if m.messages[i].streaming {
			return i
		}
	}
	return -1
}

// sealStreamingText finalizes the open streaming bubble for display: the
// session write itself belongs to the agent loop, not the UI. A block
// that never said anything is dropped, not sealed into a bare bar.
func (m *Model) sealStreamingText() {
	m.partial.Reset()
	m.partialThink.Reset()
	idx := m.streamingIndex()
	if idx < 0 {
		return
	}
	if strings.TrimSpace(m.messages[idx].raw) == "" {
		m.messages = append(m.messages[:idx], m.messages[idx+1:]...)
		return
	}
	m.messages[idx].streaming = false
}

// todoTool returns the registered todo list tool, or nil when absent.
func (m *Model) todoTool() *tools.Todos {
	t, ok := m.tools.Get("todo")
	if !ok {
		return nil
	}
	td, _ := t.(*tools.Todos)
	return td
}

// todoList snapshots the todo tool's current items, nil when the tool
// is missing from the registry.
func (m *Model) todoList() []tools.Todo {
	td := m.todoTool()
	if td == nil {
		return nil
	}
	return td.List()
}

// upsertTodoPanel refreshes the single checklist panel: the newest todo
// state replaces the previous rendering and moves to the live edge, so
// scrollback ends up with one panel showing the final list. An empty
// list removes the panel — the agent cleared its tasks. The status
// line's current-task fields mirror the same state.
func (m *Model) upsertTodoPanel(items []tools.Todo) {
	m.todoNow, m.todoDone, m.todoTotal = "", 0, len(items)
	for _, td := range items {
		switch td.Status {
		case tools.TodoInProgress:
			m.todoNow = td.Content
		case tools.TodoCompleted:
			m.todoDone++
		}
	}
	for i := range m.messages {
		if m.messages[i].kind == kindTodo {
			m.messages = append(m.messages[:i], m.messages[i+1:]...)
			break
		}
	}
	if len(items) == 0 {
		return
	}
	m.messages = append(m.messages, uiMessage{
		role: llm.RoleTool, kind: kindTodo, raw: renderTodoBody(items),
	})
}

// renderTodoBody draws the checklist body: one line per item in the
// model's execution order, marked ☑ done, ❯ in progress, ☐ pending.
func renderTodoBody(items []tools.Todo) string {
	lines := make([]string, len(items))
	for i, td := range items {
		switch td.Status {
		case tools.TodoCompleted:
			lines[i] = "☑ " + td.Content
		case tools.TodoInProgress:
			lines[i] = "❯ " + td.Content
		default:
			lines[i] = "☐ " + td.Content
		}
	}
	return strings.Join(lines, "\n")
}

// parseTodoInput extracts the item list from a todo call's input JSON;
// a malformed call (sanitized to {} in the transcript) yields nil.
func parseTodoInput(input json.RawMessage) []tools.Todo {
	var in struct {
		Items []tools.Todo `json:"items"`
	}
	if err := json.Unmarshal(input, &in); err != nil {
		return nil
	}
	return in.Items
}

// parseTodoRender recovers items from a todo result's rendered lines —
// the replay fallback when the transcript's call input was sanitized
// away. Unmarked lines (the "(task list cleared)" note) are skipped.
func parseTodoRender(out string) []tools.Todo {
	var items []tools.Todo
	for _, l := range strings.Split(out, "\n") {
		var td tools.Todo
		switch {
		case strings.HasPrefix(l, "☑ "):
			td = tools.Todo{Status: tools.TodoCompleted, Content: strings.TrimSpace(l[len("☑ "):])}
		case strings.HasPrefix(l, "❯ "):
			td = tools.Todo{Status: tools.TodoInProgress, Content: strings.TrimSpace(l[len("❯ "):])}
		case strings.HasPrefix(l, "☐ "):
			td = tools.Todo{Status: tools.TodoPending, Content: strings.TrimSpace(l[len("☐ "):])}
		default:
			continue
		}
		items = append(items, td)
	}
	return items
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
	m.phase = ""
	m.events = nil
	m.todoNow, m.todoDone, m.todoTotal = "", 0, 0
	m.activeTasks = nil
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
	// A prompt filed while the turn ran hands off to the input and
	// sends now — the next turn starts immediately (this is the only
	// drain point, and finishStream runs exactly once per turn).
	if len(m.queued) > 0 {
		m.textarea.SetValue(m.queued[0])
		m.textarea.MoveToEnd()
		m.queued = m.queued[1:]
		return tea.Batch(m.flush(), m.submit())
	}
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
	// A turn in flight files the input instead of racing it: plain
	// prompts join the queue (finishStream auto-submits them FIFO at
	// turn end), slash commands get the /compact treatment — they
	// mutate UI state the running turn may be reading, so they wait.
	if m.streaming {
		if strings.HasPrefix(input, "/") {
			m.messages = append(m.messages, uiMessage{role: "system",
				raw: "commands wait for the current turn to finish"})
			return m.flush()
		}
		m.queued = append(m.queued, input)
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
	if m.shouldGather() {
		// First real turn of a fresh session: sweep context first, then
		// answer with the brief riding the turn's preface.
		return tea.Batch(m.flush(), m.startGather(input))
	}
	return tea.Batch(m.flush(), m.startTurn(input))
}

// startTurn hands the user input to the agent loop. The loop owns session
// writes and streams events back through the same channel the provider
// pump consumed in earlier phases; permission questions ride the bridge.
func (m *Model) startTurn(input string) tea.Cmd {
	return m.startTurnWith(input, "")
}

// startTurnWith is startTurn with an optional context preface (the
// gatherer's brief) written into the transcript ahead of the user turn.
func (m *Model) startTurnWith(input, preface string) tea.Cmd {
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
	m.todoNow, m.todoDone, m.todoTotal = "", 0, 0 // fresh turn, no task yet
	runner := &agent.Runner{
		Provider:        m.provider,
		Session:         m.session,
		Tools:           m.tools,
		Model:           m.cfg.Model(),
		MaxTokens:       m.cfg.MaxTokens,
		ReasoningEffort: m.cfg.ReasoningEffortValue(),
		System:          agent.SystemPrompt(m.workdir),
		Mode:            func() perm.Mode { return m.mode() },
		Approver:        m.approvals,
		Hooks:           hooks.New(m.cfg.Hooks, m.workdir),
		Preface:         preface,
	}
	debug.Printf("start turn: %s/%s session=%s", m.provider.Name(), m.cfg.Model(), m.session.Name())
	ch := runner.Run(ctx, input)

	m.cancel = cancel
	m.events = ch
	m.streaming = true
	m.phase = ""
	m.lastErr = ""
	m.turnStart = time.Now()
	m.partial.Reset()
	m.partialThink.Reset()
	return tea.Batch(m.pump(), m.spinner.Tick)
}

// gatherMaxRounds bounds the context gatherer's tool loop: it should
// sweep quickly, not settle in.
const gatherMaxRounds = 15

// shouldGather reports whether the automatic context gatherer runs for
// this prompt: the first real turn of a fresh session (empty
// transcript), when the config toggle is on.
func (m *Model) shouldGather() bool {
	return m.cfg.GatherOn() && len(m.session.Messages()) == 0
}

// startGather runs the read-only context gatherer ahead of the first
// real turn: its events ride the same stream channel (handleStreamEvent
// routes by m.gathering) and its live block shows the sweep's activity.
func (m *Model) startGather(input string) tea.Cmd {
	ctx, cancel := context.WithCancel(context.Background())
	model := m.cfg.Model()
	if fast := m.cfg.SubModel(); fast != "" {
		model = fast
	}
	sub := &agent.Runner{
		Provider:        m.provider,
		Session:         agent.NewMemorySession(),
		Tools:           agent.GathererRegistry(m.workdir),
		Model:           model,
		MaxTokens:       m.cfg.MaxTokens,
		ReasoningEffort: m.cfg.ReasoningEffortValue(),
		System:          agent.GathererSystemPrompt(m.workdir),
		MaxRounds:       gatherMaxRounds,
		Mode:            func() perm.Mode { return m.mode() },
		// No approver: the gatherer is read-only, so nothing it does can
		// ask, and a mid-run mode switch only ever loosens reads.
		Hooks: hooks.New(m.cfg.Hooks, m.workdir),
	}
	prompt := "Build the context brief for the request below — it is the " +
		"first task of a fresh session. End with only the brief.\n\n<request>\n" +
		input + "\n</request>"
	ch := sub.Run(ctx, prompt)

	m.cancel = cancel
	m.events = ch
	m.streaming = true
	m.gathering = true
	m.phase = ""
	m.lastErr = ""
	m.turnStart = time.Now()
	m.gatherText = new(strings.Builder)
	m.gatherInput = input
	m.gatherIdx = len(m.messages)
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, kind: kindGather, streaming: true})
	return tea.Batch(m.pump(), m.spinner.Tick)
}

// handleGatherEvent consumes the gatherer's stream while m.gathering.
func (m *Model) handleGatherEvent(ev llm.Event) tea.Cmd {
	if _, retry := ev.(llm.RetryEvent); !retry {
		m.retryNote = "" // the stream moved on; the note only explains waiting
	}
	switch e := ev.(type) {
	case llm.TextDeltaEvent:
		m.gatherText.WriteString(e.Text)
		m.touchGatherBlock(func(blk *uiMessage) { blk.raw = m.gatherText.String() })
		return m.pump()

	case llm.ToolCallEvent:
		m.touchGatherBlock(func(blk *uiMessage) {
			blk.subLine = gatherActivity(e.Name, e.Input)
		})
		return m.pump()

	case llm.ErrorEvent:
		if errors.Is(e.Err, context.Canceled) {
			// esc during the gather stops the whole submit; the user
			// resubmits to go straight to the answer.
			return m.finishGather(false)
		}
		// A failed gather never blocks the turn: note it and answer
		// without a brief.
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: "context gather failed — continuing without it"})
		return m.finishGather(false)

	case llm.DoneEvent:
		return m.finishGather(true)
	}
	return m.pump()
}

// touchGatherBlock mutates the in-flight gather block and drops its
// render cache.
func (m *Model) touchGatherBlock(f func(*uiMessage)) {
	if m.gatherIdx < 0 || m.gatherIdx >= len(m.messages) {
		return
	}
	blk := m.messages[m.gatherIdx]
	f(&blk)
	blk.rendered = ""
	m.messages[m.gatherIdx] = blk
}

// finishGather ends the gather phase: proceed=true starts the main turn
// (with the brief as Preface when one was gathered), proceed=false stops
// without a turn — the esc path. The live gather block becomes the same
// dim context-brief block a resume would render, so live and replay
// agree.
func (m *Model) finishGather(proceed bool) tea.Cmd {
	m.gathering = false
	m.gatherIdx = -1

	// Harvest the streamed brief, then convert or drop the gather block.
	brief := ""
	if m.gatherText != nil {
		brief = strings.TrimSpace(m.gatherText.String())
	}
	m.gatherText = nil

	for i := len(m.messages) - 1; i >= 0; i-- {
		if m.messages[i].kind != kindGather {
			continue
		}
		blk := m.messages[i]
		blk.streaming = false
		blk.subLine = ""
		if brief != "" {
			blk.kind = kindContext
			blk.raw = "<task-context>\n" + brief + "\n</task-context>"
			blk.rendered = ""
			m.messages[i] = blk
		} else {
			m.messages = append(m.messages[:i], m.messages[i+1:]...)
		}
		break
	}

	input := m.gatherInput
	m.gatherInput = ""
	if !proceed {
		// esc stopped the whole submit: wind the stream down, no turn.
		return m.finishStream()
	}
	return tea.Batch(m.flush(), m.startTurnWith(input, brief))
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
		Provider:        m.provider,
		Session:         m.session,
		Tools:           m.tools,
		Model:           m.cfg.Model(),
		MaxTokens:       m.cfg.MaxTokens,
		ReasoningEffort: m.cfg.ReasoningEffortValue(),
		System:          agent.SystemPrompt(m.workdir),
		Mode:            func() perm.Mode { return m.mode() },
		Approver:        m.approvals,
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

	case "/agents":
		m.openAgentsPanel()

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
		// The breathing mark replaces the MiniDot here: the phase's own
		// glyph swells cyan→mint on the turn clock while the verb names
		// what the turn is doing right now.
		state = breathStyle(m.breathElapsed()).Render(m.statusGlyph()+" ") +
			statusStyle.Render(m.phaseVerb()) +
			dimStyle.Render(" · "+elapsed.String())
		if m.todoNow != "" {
			state += statusStyle.Render(" · ❯ " + clip(m.todoNow, max(12, m.width/4)))
			if m.todoTotal > 0 {
				state += dimStyle.Render(fmt.Sprintf(" · %d/%d", m.todoDone, m.todoTotal))
			}
		}
		if m.retryNote != "" {
			state += warnStyle.Render(" · " + clip(m.retryNote, max(20, m.width/2)))
		}
		state += dimStyle.Render(" · esc to stop")
	case m.lastErr != "":
		state = errorStyle.Render(m.icons().err + " " + clip(m.lastErr, max(20, m.width/2)))
	default:
		state = okStyle.Render(m.icons().ready + " ready")
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
		out = m.toolCallBlock(msg.raw, width)
		if msg.subLine != "" {
			// The in-flight subagent's latest activity, dim under the
			// call line; the report block replaces it when the task ends.
			out += "\n" + dimStyle.Render("  ⎿ "+clip(msg.subLine, width-6))
		}
	case msg.kind == kindDiff:
		out = diffBlock(msg.raw, msg.diff, msg.path, width, msg.expanded)
	case msg.kind == kindTodo:
		out = m.todoPanelBlock(msg.raw, width)
	case msg.kind == kindContext:
		out = m.contextBlock(msg.raw, width, msg.expanded)
	case msg.kind == kindGather:
		out = m.gatherBlock(msg, width)
	case msg.kind == kindThinking:
		out = m.thinkingBlock(msg, width)
	case msg.kind == kindToolResult:
		if msg.expanded {
			out = resultDetailBlock(msg.raw, msg.isErr, width)
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
		out = userBar.Width(width).Render(userMark.Render(m.icons().user+" ") + strings.Join(wlines, "\n  "))
	case msg.role == llm.RoleAssistant:
		// Prose rides the answer bar under an attribution header: the
		// spark mark (breathing while the block streams, bright on the
		// turn's final message) over the dim role word. The bar beneath
		// is bright cyan on the turn's final answer, dim teal mid-turn.
		bar := answerBar
		if msg.final {
			bar = answerBarFinal
		}
		body := renderAnswer(msg.raw, width, bar, msg.streaming, m.breathElapsed())
		if body == "" {
			break // a just-opened block: no bare attribution line
		}
		out = m.agentHeader(msg.streaming, msg.final) + "\n" + body
	default:
		if strings.HasPrefix(msg.raw, "error: ") {
			// A turn that died on an error is the loud end: red and
			// bold, not a dim italic whisper.
			out = errorStyle.Width(width).Render(m.icons().err + " " + msg.raw)
		} else {
			out = systemStyle.Width(width).Render(m.icons().system + " " + msg.raw)
		}
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

// ansiRe matches SGR/CSI escape sequences so styled rows can be
// measured: a padding-only row and a bare bar glyph compare equal once
// the styling is stripped.
var ansiRe = regexp.MustCompile(`\x1b\[[0-9;:]*[a-zA-Z]`)

func stripANSI(s string) string { return ansiRe.ReplaceAllString(s, "") }

// trailingPadRe matches the padded tail of a bar-rendered row: runs of
// ANSI-wrapped whitespace, the way lipgloss pads each row to the block
// width (every padding cell arrives as its own style span).
var trailingPadRe = regexp.MustCompile(`(?:\x1b\[[0-9;:]*m\s*)+$`)

// renderAnswer renders assistant prose on its answer bar. Trailing rows
// that carry nothing but the bar are dropped first: raw text mid-stream
// often ends inside an unfinished markdown construct (an unclosed code
// fence, a started list or heading), which glamour renders as an empty
// final row — left alone it paints a stray bar-only line that reads as
// a second vertical rule beside the text. A raw that is only
// whitespace renders nothing at all. While streaming, the cursor rides
// the breath's tint, appended after trimming the last row's padded
// tail: the bar style pads every row to the block width, and a cursor
// appended behind that padding lands one cell past the viewport's
// content width, where it wraps onto a bare cursor row at column 0 —
// the thin-bar-over-thick-bar artifact under a streaming reply.
func renderAnswer(raw string, width int, bar lipgloss.Style, streaming bool, elapsed time.Duration) string {
	if strings.TrimSpace(raw) == "" {
		return ""
	}
	lines := strings.Split(bar.Width(width).Render(renderMarkdown(raw, width-answerBarOverhead)), "\n")
	for len(lines) > 1 && strings.TrimSpace(stripANSI(lines[len(lines)-1])) == "┃" {
		lines = lines[:len(lines)-1]
	}
	if streaming {
		lines[len(lines)-1] = trailingPadRe.ReplaceAllString(lines[len(lines)-1], "")
	}
	out := strings.Join(lines, "\n")
	if streaming {
		out += streamCursor.Foreground(breathColor(elapsed)).Render("▌")
	}
	return out
}

// agentHeader is the assistant's attribution line: the spark mark over
// the dim role word. The mark breathes while the block streams, runs
// bright cyan on the turn's final message, and stays dim mid-turn.
func (m Model) agentHeader(streaming, final bool) string {
	mark := m.icons().agent
	var styled string
	switch {
	case streaming:
		styled = breathStyle(m.breathElapsed()).Render(mark)
	case final:
		styled = toolStyle.Render(mark)
	default:
		styled = dimStyle.Render(mark)
	}
	return styled + dimStyle.Render(" khode")
}

// thinkingBlock renders the model's private reasoning: an icon + role
// label header, the dim italic body under it. The icon breathes while
// the phase is live and rests dim once the block seals.
func (m Model) thinkingBlock(msg uiMessage, width int) string {
	head := dimStyle.Render(m.icons().thinking + " thinking")
	if msg.streaming {
		head = breathStyle(m.breathElapsed()).Render(m.icons().thinking) +
			dimStyle.Render(" thinking")
	}
	return head + "\n" + thinkStyle.Width(width).Render(msg.raw)
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

// formatToolCall renders a tool call as one compact line: name plus a
// readable summary of the arguments — the command for bash, the file
// for write-class tools — falling back to the compacted JSON when a
// tool has no friendlier shape.
func formatToolCall(c llm.ToolCall) string {
	line := c.Name
	if args := toolCallArgs(c.Name, c.Input); args != "" {
		line += " " + args
	}
	return truncate(line, 200)
}

// toolCallArgs summarizes a tool call's input for the activity line.
// The plan call shows nothing: its dialog is the feedback (same rule as
// the todo panel); task shows its description; everything else the UI
// has no shape for keeps the raw JSON.
func toolCallArgs(name string, input json.RawMessage) string {
	var a struct {
		Command     string `json:"command"`
		Path        string `json:"path"`
		Pattern     string `json:"pattern"`
		Description string `json:"description"`
	}
	if json.Unmarshal(input, &a) != nil {
		return compactJSON(input)
	}
	switch name {
	case "bash":
		return oneLine(a.Command)
	case "read", "write", "edit":
		return a.Path
	case "glob", "grep":
		return a.Pattern
	case "plan":
		return ""
	case "task":
		if a.Description != "" {
			return oneLine(a.Description)
		}
	}
	return compactJSON(input)
}

// writeToolPath extracts the file a write-class call targets — the
// diff block lexes its code by the file it changed. "" for any other
// tool or unparseable input.
func writeToolPath(name string, input json.RawMessage) string {
	if name != "edit" && name != "write" {
		return ""
	}
	var a struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(input, &a); err != nil {
		return ""
	}
	return a.Path
}

// oneLine flattens a multi-line string for the activity line: newlines
// become spaces and runs of whitespace collapse.
func oneLine(s string) string {
	return strings.Join(strings.Fields(s), " ")
}

// diffPreviewLines caps the change block the chat shows for one
// edit/write call.
const diffPreviewLines = 20

// diffBlock renders a write-class result as a Grok-style change: the ⎿
// summary line, then the banded, line-numbered diff flush left under
// it, capped at diffPreviewLines lines unless expanded.
func diffBlock(summary, diff, path string, width int, expanded bool) string {
	lines := renderDiffLines(diff, path, width)
	if !expanded && len(lines) > diffPreviewLines {
		lines = append(lines[:diffPreviewLines],
			dimStyle.Render(fmt.Sprintf("… %d more diff lines · ctrl+o to expand",
				len(lines)-diffPreviewLines)))
	}
	if expanded {
		lines = append(lines, dimStyle.Render("· ctrl+o to collapse"))
	}
	return resultStyle.Render("⎿  "+summary) + "\n" + strings.Join(lines, "\n")
}

// resultDetailBlock renders a tool result in full: every output line
// hanging under the ⎿ header, errors in red without the header's bold.
func resultDetailBlock(raw string, isErr bool, width int) string {
	lines := strings.Split(strings.TrimRight(raw, "\n"), "\n")
	headStyle, bodyStyle := resultStyle, resultStyle
	if isErr {
		headStyle, bodyStyle = errorStyle, errDetailStyle
	}
	head := "⎿  "
	if isErr {
		head += "error: "
	}
	out := make([]string, 0, len(lines)+1)
	out = append(out, headStyle.Render(head+clip(lines[0], width-3)))
	for _, l := range lines[1:] {
		out = append(out, bodyStyle.Render("   "+clip(l, width-3)))
	}
	out = append(out, dimStyle.Render("   · ctrl+o to collapse"))
	return strings.Join(out, "\n")
}

// toggleExpand flips the most recent block that hides detail — a tool
// result longer than its preview or a capped diff — between its
// summary and its full output.
func (m *Model) toggleExpand() {
	for i := len(m.messages) - 1; i >= 0; i-- {
		if !expandable(m.messages[i]) {
			continue
		}
		m.messages[i].expanded = !m.messages[i].expanded
		m.messages[i].rendered = "" // re-render at the new size
		return
	}
}

// expandable reports whether a block hides detail the user can reveal
// with ctrl+o or a click.
func expandable(msg uiMessage) bool {
	switch msg.kind {
	case kindToolResult:
		return strings.Count(strings.TrimRight(msg.raw, "\n"), "\n")+1 > toolResultPreviewLines
	case kindDiff:
		return strings.Count(strings.TrimRight(msg.diff, "\n"), "\n")+1 > diffPreviewLines
	case kindContext:
		return contextBriefLines(msg.raw) > contextPreviewLines
	}
	return false
}

// contextPreviewLines caps a collapsed context brief.
const contextPreviewLines = 4

// gatherBlock renders the in-flight first-prompt context gatherer: a
// cyan-headed live block whose subLine carries the sweep's latest read.
// The mark breathes while the sweep runs.
func (m Model) gatherBlock(msg uiMessage, width int) string {
	mark := m.icons().gather
	out := toolStyle.Render(mark + " gathering context")
	if msg.streaming {
		out = breathStyle(m.breathElapsed()).Render(mark) + toolStyle.Render(" gathering context")
	}
	if msg.subLine != "" {
		room := width - 24
		if room < 12 {
			room = 12
		}
		out += dimStyle.Render(" · " + clip(msg.subLine, room))
	}
	return out
}

// gatherActivity renders a gatherer tool call as one dim activity line
// ("read internal/agent/loop.go") for the live block.
func gatherActivity(name string, input json.RawMessage) string {
	var a struct {
		Command string `json:"command"`
		Path    string `json:"path"`
		Pattern string `json:"pattern"`
	}
	if json.Unmarshal(input, &a) != nil {
		return name
	}
	switch name {
	case "bash":
		return "bash " + oneLine(a.Command)
	case "glob":
		return "glob " + oneLine(a.Pattern)
	case "grep":
		return "grep " + oneLine(a.Pattern)
	case "read":
		return "read " + oneLine(a.Path)
	}
	return name
}

// contextBriefLines counts the brief's body lines (the <task-context>
// wrapper tags stripped).
func contextBriefLines(raw string) int {
	body := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(raw), "<task-context>"), "</task-context>")
	body = strings.TrimSpace(body)
	if body == "" {
		return 0
	}
	return strings.Count(body, "\n") + 1
}

// contextBlock renders a replayed gatherer brief: dim, headed by its
// origin, capped at contextPreviewLines until expanded.
func (m Model) contextBlock(raw string, width int, expanded bool) string {
	body := strings.TrimSuffix(strings.TrimPrefix(strings.TrimSpace(raw), "<task-context>"), "</task-context>")
	lines := strings.Split(strings.TrimRight(body, "\n"), "\n")
	head := dimStyle.Render(m.icons().context + " context brief · gathered for this task")
	if len(lines) == 1 && strings.TrimSpace(lines[0]) == "" {
		lines = nil
	}
	if !expanded && len(lines) > contextPreviewLines {
		lines = append(lines[:contextPreviewLines],
			dimStyle.Render(fmt.Sprintf("… %d more lines · ctrl+o to expand", len(lines)-contextPreviewLines)))
	} else if expanded && len(lines) > contextPreviewLines {
		lines = append(lines, dimStyle.Render("· ctrl+o to collapse"))
	}
	out := head
	for _, l := range lines {
		out += "\n  " + dimStyle.Render(clip(l, width-4))
	}
	return out
}

// toolCallBlock renders a tool call two-tone: the tool's mark and name
// in cyan, the arguments dim behind them.
func (m Model) toolCallBlock(raw string, width int) string {
	name, args := raw, ""
	if i := strings.IndexByte(raw, ' '); i >= 0 {
		name, args = raw[:i], raw[i+1:]
	}
	out := toolStyle.Render(toolMark(m.icons(), name) + " " + name)
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
			fmt.Sprintf("  (+%d more lines · ctrl+o)", len(lines)-toolResultPreviewLines)
	}
	return truncate(strings.Join(shown, " · "), 200)
}

// todoPanelBlock draws the agent's task checklist as a bordered card:
// a done/total title over one styled line per item, clipped to the
// card's column budget.
func (m Model) todoPanelBlock(body string, width int) string {
	lim := max(16, min(width-6, 56))
	lines := strings.Split(body, "\n")
	done := 0
	styled := make([]string, len(lines))
	for i, raw := range lines {
		line := clip(raw, lim)
		switch {
		case strings.HasPrefix(raw, "☑"):
			done++
			styled[i] = todoDone.Render(line)
		case strings.HasPrefix(raw, "❯"):
			styled[i] = todoActive.Render(line)
		default:
			styled[i] = todoPending.Render(line)
		}
	}
	title := todoTitle.Render(fmt.Sprintf("%s Tasks · %d/%d", m.icons().todo, done, len(lines)))
	return todoPanel.Render(
		lipgloss.JoinVertical(lipgloss.Left, append([]string{title}, styled...)...))
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
