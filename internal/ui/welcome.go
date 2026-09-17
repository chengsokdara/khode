package ui

// welcome.go — the first-run walkthrough. khode opens it when no
// credentials exist anywhere: three short steps (intro, provider, api
// key) and a ready card with what to try first. Esc skips it at any
// point — khode stays usable, and the pre-flight check points at
// /settings if a turn is attempted without a key.

import (
	"fmt"
	"strings"

	"khode/internal/llm"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// welcome steps, in order.
const (
	welcomeIntro = iota
	welcomeProvider
	welcomeKey
	welcomeReady
	welcomeSteps // keep last
)

// welcome is the first-run walkthrough; Model.welcome is non-nil while
// it is open.
type welcome struct {
	step     int
	input    textinput.Model // api-key editor on the key step
	savedMsg string          // last "✓ …" flash from a save
}

// OpenWelcome starts the walkthrough at the intro card.
func (m *Model) OpenWelcome() {
	in := textinput.New()
	in.Prompt = ""
	in.EchoMode = textinput.EchoPassword
	in.EchoCharacter = '•'
	in.Width = 52
	in.Placeholder = "paste your API key · enter saves"
	in.Focus()
	m.welcome = &welcome{step: welcomeIntro, input: in}
}

// welcomeKey handles input while the walkthrough is open.
func (m *Model) welcomeKey(msg tea.KeyMsg) tea.Cmd {
	w := m.welcome
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "esc":
		// Skipping is always allowed: setup is optional.
		m.welcome = nil
		return nil
	}

	switch w.step {
	case welcomeIntro:
		if msg.String() == "enter" {
			w.step = welcomeProvider
		}

	case welcomeProvider:
		switch msg.String() {
		case "left", "h":
			m.switchProvider(neighborProvider(m.cfg.Provider, -1))
		case "right", "l":
			m.switchProvider(neighborProvider(m.cfg.Provider, 1))
		case "enter":
			w.step = welcomeKey
		}

	case welcomeKey:
		switch msg.String() {
		case "enter":
			return m.commitWelcomeKey()
		case "shift+tab":
			w.step = welcomeProvider
		default:
			var cmd tea.Cmd
			w.input, cmd = w.input.Update(msg)
			return cmd
		}

	case welcomeReady:
		if msg.String() == "enter" {
			m.welcome = nil
		}
	}
	return nil
}

// commitWelcomeKey saves the pasted key and moves to the ready card.
// An empty key is not an error: the walkthrough still advances, and the
// pre-flight check points at /settings if a turn is attempted.
func (m *Model) commitWelcomeKey() tea.Cmd {
	w := m.welcome
	key := strings.TrimSpace(w.input.Value())
	if key != "" {
		m.auth.SetKey(m.cfg.Provider, key)
		if err := m.auth.Save(); err != nil {
			m.lastErr = err.Error()
			return nil
		}
		m.rebuildProvider()
	}
	w.step = welcomeReady
	return nil
}

// neighborProvider returns the provider dir steps around name, wrapping.
func neighborProvider(name string, dir int) string {
	names := llm.Names()
	idx := 0
	for i, n := range names {
		if n == name {
			idx = i
		}
	}
	return names[(idx+dir+len(names))%len(names)]
}

func (m *Model) welcomeView() string {
	w := m.welcome
	var title, body string
	switch w.step {
	case welcomeIntro:
		title = "◆ welcome to khode"
		body = strings.Join([]string{
			"a coding agent for your terminal.",
			"",
			"  " + pickSel.Render("·") + " reads, edits, and runs code here — always with your approval",
			"  " + pickSel.Render("·") + " answers stream from Anthropic or OpenAI models",
			"  " + pickSel.Render("·") + " every session is saved; resume with khode --resume",
			"",
			"setup takes a minute: pick a provider, paste a key.",
		}, "\n")
	case welcomeProvider:
		title = "◆ pick a provider"
		body = strings.Join([]string{
			"  provider   " + pickSel.Render(m.cfg.Provider),
			"  model      " + m.cfg.Model() + dimStyle.Render("  (default)"),
			"",
			dimStyle.Render("  keys are stored per provider; you can switch any time."),
		}, "\n")
	case welcomeKey:
		title = "◆ paste your API key"
		body = strings.Join([]string{
			"  " + m.cfg.Provider + " key:",
			"",
			"  " + w.input.View(),
			"",
			dimStyle.Render("  stored in ~/.khode/auth.json · owner-only · never displayed"),
		}, "\n")
	case welcomeReady:
		title = "◆ you're set"
		body = strings.Join([]string{
			"try asking khode:",
			"",
			"  " + userStyle.Render("summarize what this repo does"),
			"  " + userStyle.Render("find and fix the failing test"),
			"",
			dimStyle.Render("  /help commands · /settings configuration · esc stops a stream"),
		}, "\n")
	}

	var footer string
	switch w.step {
	case welcomeIntro:
		footer = keyHint("enter", "start setup") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
	case welcomeProvider:
		footer = keyHint("←/→", "switch") + dimStyle.Render("  ·  ") + keyHint("enter", "continue") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
	case welcomeKey:
		footer = keyHint("enter", "save") + dimStyle.Render("  ·  ") + keyHint("shift+tab", "back") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
	case welcomeReady:
		footer = keyHint("enter", "start chatting")
	}
	if w.savedMsg != "" {
		footer = okStyle.Render(w.savedMsg) + "\n" + footer
	}

	head := title + dimStyle.Render(fmt.Sprintf("  ·  step %d/%d", w.step+1, welcomeSteps-1))
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, head, "", body, "", footer))
	return lipgloss.Place(m.width, m.height, lipgloss.Center, lipgloss.Center, box)
}
