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

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/llm"
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
	history   bool
}

// Model is the root Bubble Tea model.
type Model struct {
	cfg      *config.Config
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

	picker *picker // session chooser overlay; nil when closed

	streaming bool
	cancel    context.CancelFunc
	events    <-chan llm.Event
	partial   strings.Builder // text accumulated for the in-flight reply

	inTokens  int64
	outTokens int64
	cost      float64
	hasCost   bool // price known for the models used so far

	lastErr string
}

// New builds the root model, restoring prior conversation history from the
// session transcript (used by --resume).
func New(cfg *config.Config, p llm.Provider, sess *agent.Session, reg *tools.Registry, workdir string) Model {
	ta := textarea.New()
	ta.Placeholder = "Ask khode to do something…"
	ta.Prompt = " "
	ta.ShowLineNumbers = false
	ta.CharLimit = 0
	ta.MaxHeight = maxInputHeight
	ta.KeyMap.InsertNewline = key.NewBinding(
		key.WithKeys("alt+enter"),
		key.WithHelp("alt+enter", "newline"),
	)
	ta.Focus()
	ta.SetWidth(60)
	ta.SetHeight(minInputHeight)

	sp := spinner.New(spinner.WithSpinner(spinner.MiniDot))

	m := Model{
		cfg:      cfg,
		provider: p,
		session:  sess,
		tools:    reg,
		workdir:  workdir,
		textarea: ta,
		spinner:  sp,
		viewport: viewport.New(60, 10),
	}

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
			if msg.Content != "" {
				m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true})
			}
			for _, c := range msg.ToolCalls {
				m.messages = append(m.messages, uiMessage{
					role: msg.Role, kind: kindToolCall, raw: formatToolCall(c), history: true,
				})
			}
		default:
			m.messages = append(m.messages, uiMessage{role: msg.Role, raw: msg.Content, history: true})
		}
	}
	m.banner()
	return m
}

func (m *Model) banner() {
	m.messages = append(m.messages, uiMessage{
		role: "system",
		raw: fmt.Sprintf("khode v%s · %s/%s · session %s · /help for commands",
			Version, m.provider.Name(), m.cfg.Model(), m.session.Name()),
	})
}

// useSession makes sess the active conversation and resets the view.
func (m *Model) useSession(sess *agent.Session) {
	m.session = sess
	m.messages = nil
	m.banner()
	m.renderAll()
}

// --- tea.Model -------------------------------------------------------------

type streamEventMsg struct{ ev llm.Event }

// streamClosedMsg arrives when the provider closed the event channel without
// a terminal event (e.g. ctx cancelled before we drained it).
type streamClosedMsg struct{}

func (m Model) Init() tea.Cmd {
	return tea.Batch(textarea.Blink, m.spinner.Tick)
}

func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.textarea.SetWidth(max(10, m.width-6))
		m.relayout()
		m.invalidateRendered()
		m.renderAll()
		return m, nil

	case tea.MouseMsg:
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

	case tea.KeyMsg:
		if m.picker != nil {
			return m, m.pickerKey(msg)
		}
		switch {
		case msg.Type == tea.KeyCtrlC:
			m.stopStream()
			return m, tea.Quit
		case msg.Type == tea.KeyEsc && m.streaming:
			m.stopStream()
			return m, nil
		case msg.Type == tea.KeyEnter && !msg.Alt:
			if m.streaming {
				return m, nil
			}
			return m, m.submit()
		}
		var cmd tea.Cmd
		m.textarea, cmd = m.textarea.Update(msg)
		m.maybeGrowInput()
		return m, cmd
	}

	return m, nil
}

func (m Model) View() string {
	if m.width == 0 {
		return "starting…"
	}
	if m.picker != nil {
		return m.pickerView()
	}

	header := lipgloss.NewStyle().Width(m.width).Render(
		titleStyle.Render("◆ khode") +
			dimStyle.Render(fmt.Sprintf(" v%s · %s/%s · %s", Version, m.provider.Name(), m.cfg.Model(), m.session.Name())),
	)

	status := m.statusLine()
	inputBox := inputBorder.Render(m.textarea.View())
	help := dimStyle.Width(m.width).Render(
		"enter send · alt+enter newline · esc stop stream · ctrl+c quit",
	)

	return lipgloss.JoinVertical(lipgloss.Left,
		header,
		viewportStyle.Render(m.viewport.View()),
		status,
		inputBox,
		help,
	)
}

// --- streaming -------------------------------------------------------------

func waitForEvents(ch <-chan llm.Event) tea.Cmd {
	return func() tea.Msg {
		ev, ok := <-ch
		if !ok {
			return streamClosedMsg{}
		}
		return streamEventMsg{ev: ev}
	}
}

func (m *Model) handleStreamEvent(ev llm.Event) tea.Cmd {
	switch e := ev.(type) {
	case llm.TextDeltaEvent:
		m.ensureStreamingBlock()
		m.partial.WriteString(e.Text)
		if idx := len(m.messages) - 1; idx >= 0 && m.messages[idx].streaming {
			m.messages[idx].raw = m.partial.String()
		}
		m.renderAll()
		return waitForEvents(m.events)

	case llm.ToolCallEvent:
		m.sealStreamingText()
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleAssistant, kind: kindToolCall, raw: formatToolCall(e.ToolCall),
		})
		m.renderAll()
		return waitForEvents(m.events)

	case llm.ToolResultEvent:
		m.messages = append(m.messages, uiMessage{
			role: llm.RoleTool, kind: kindToolResult, raw: e.Output, isErr: e.IsError,
		})
		m.renderAll()
		return waitForEvents(m.events)

	case llm.UsageEvent:
		m.inTokens += e.InputTokens
		m.outTokens += e.OutputTokens
		if c, ok := llm.CostEstimate(m.cfg.Model(), e.InputTokens, e.OutputTokens); ok {
			m.cost += c
			m.hasCost = true
		}
		return waitForEvents(m.events)

	case llm.ErrorEvent:
		if !errors.Is(e.Err, context.Canceled) {
			m.lastErr = e.Err.Error()
		}
		return m.finishStream()

	case llm.DoneEvent:
		return m.finishStream()
	}
	return waitForEvents(m.events)
}

// ensureStreamingBlock opens a fresh streaming text bubble when the last
// block is not one (turn start, or a new round after tool calls).
func (m *Model) ensureStreamingBlock() {
	if len(m.messages) > 0 && m.messages[len(m.messages)-1].streaming {
		return
	}
	m.messages = append(m.messages, uiMessage{role: llm.RoleAssistant, streaming: true, history: true})
}

// sealStreamingText finalizes the open streaming bubble for display: the
// session write itself belongs to the agent loop, not the UI.
func (m *Model) sealStreamingText() {
	m.partial.Reset()
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
	if input == "" {
		return nil
	}
	if strings.HasPrefix(input, "/") {
		return m.command(input)
	}

	m.messages = append(m.messages, uiMessage{role: llm.RoleUser, raw: input, history: true})
	m.renderAll()
	return m.startTurn(input)
}

// startTurn hands the user input to the agent loop. The loop owns session
// writes and streams events back through the same channel the provider
// pump consumed in earlier phases.
func (m *Model) startTurn(input string) tea.Cmd {
	ctx, cancel := context.WithCancel(context.Background())
	runner := &agent.Runner{
		Provider:  m.provider,
		Session:   m.session,
		Tools:     m.tools,
		Model:     m.cfg.Model(),
		MaxTokens: m.cfg.MaxTokens,
		System:    agent.DefaultSystemPrompt(m.workdir),
	}
	ch := runner.Run(ctx, input)

	m.cancel = cancel
	m.events = ch
	m.streaming = true
	m.lastErr = ""
	m.partial.Reset()
	return tea.Batch(waitForEvents(ch), m.spinner.Tick)
}

func (m *Model) command(input string) tea.Cmd {
	parts := strings.Fields(input)
	switch parts[0] {
	case "/help":
		m.messages = append(m.messages, uiMessage{role: "system", raw: strings.Join([]string{
			"/new [name]   fresh session, optionally named",
			"/sessions     switch session (picker)",
			"/model <name> switch model (persisted)",
			"/tools        list tools the model can call",
			"/exit, /quit  leave khode",
			"/help         this list",
		}, "\n")})

	case "/tools":
		names := m.tools.Names()
		if len(names) == 0 {
			m.messages = append(m.messages, uiMessage{role: "system", raw: "no tools registered"})
			break
		}
		var lines []string
		for _, n := range names {
			t, _ := m.tools.Get(n)
			lines = append(lines, fmt.Sprintf("%-6s %s", n, t.Description()))
		}
		m.messages = append(m.messages, uiMessage{role: "system", raw: strings.Join(lines, "\n")})

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

func (m *Model) statusLine() string {
	var state string
	switch {
	case m.streaming:
		state = m.spinner.View() + statusStyle.Render(" working… (esc to stop)")
	case m.lastErr != "":
		state = errorStyle.Render("✗ " + m.lastErr)
	default:
		state = okStyle.Render("● ready")
	}
	tok := dimStyle.Render(fmt.Sprintf("in %s · out %s · %s",
		humanTokens(m.inTokens), humanTokens(m.outTokens), m.costLabel()))

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
		out = toolStyle.Width(width).Render("⏺ " + msg.raw)
	case msg.kind == kindToolResult:
		body := summarizeToolResult(msg.raw)
		style := resultStyle
		prefix := "⎿  "
		if msg.isErr {
			style = errorStyle
			prefix = "⎿  error: "
		}
		out = style.Width(width).Render(prefix + body)
	case msg.role == llm.RoleUser:
		out = userStyle.Width(width).Render("❯ " + msg.raw)
	case msg.role == llm.RoleAssistant:
		if msg.streaming {
			out = dimStyle.Width(width).Render(msg.raw)
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
	vh := m.height - inputH - 3       // header + status + help
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
