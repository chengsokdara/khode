package ui

// welcome.go — the first-run walkthrough. khode opens it when no
// credentials exist anywhere: intro, provider (built-ins, any custom
// provider already configured, or an inline form to add one), api key,
// and a ready card with what to try first. Esc skips it at any point —
// khode stays usable, and the pre-flight check points at /settings if a
// turn is attempted without a key or model.

import (
	"fmt"
	"strings"

	"khode/internal/config"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// welcome steps, in order. The model step is skipped entirely when the
// chosen provider already has a model (built-in defaults), so most
// users never see it — khateway and custom endpoints always do, since
// only the endpoint knows which models exist.
const (
	welcomeIntro = iota
	welcomeProvider
	welcomeCustom
	welcomeKey
	welcomeModel
	welcomeReady
	welcomeSteps // keep last
)

// welcomeCustomEntry is the provider step's last option: instead of
// naming a provider, it opens the inline custom-provider form.
const welcomeCustomEntry = "custom…"

// welcome is the first-run walkthrough; Model.welcome is non-nil while
// it is open.
type welcome struct {
	step     int
	provIdx  int             // cursor in the provider step's choice list
	input    textinput.Model // api-key editor on the key step
	cName    textinput.Model // custom provider form: name
	cURL     textinput.Model // custom provider form: base url
	cField   int             // custom form: 0 name, 1 url, 2 protocol, 3 save
	cProto   int             // custom form: 0 openai, 1 anthropic
	savedMsg string          // last "✓ …" flash from a save

	models   []string // fetched choices on the model step
	mCur     int      // cursor in models
	fetching bool     // model-list request in flight
	fetchErr string   // non-empty when the fetch failed
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

	name := textinput.New()
	name.Prompt = ""
	name.Width = 40
	name.Placeholder = "unique name (e.g. groq, ollama)"
	url := textinput.New()
	url.Prompt = ""
	url.Width = 40
	url.Placeholder = "http://localhost:11434/v1"

	w := &welcome{input: in, cName: name, cURL: url}
	// The provider cursor starts on the configured provider.
	w.provIdx = indexOf(m.providerNames(), m.cfg.Provider)
	if w.provIdx < 0 {
		w.provIdx = 0
	}
	w.focusCustom()
	m.welcome = w
}

// providerChoices lists the walkthrough's provider options: the
// built-ins, any custom providers already configured, and the entry
// that opens the inline add form.
func (m *Model) providerChoices() []string {
	return append(m.providerNames(), welcomeCustomEntry)
}

// focusCustom moves the custom form's input focus to its current field.
func (w *welcome) focusCustom() {
	w.cName.Blur()
	w.cURL.Blur()
	switch w.cField {
	case 0:
		w.cName.Focus()
	case 1:
		w.cURL.Focus()
	}
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
		choices := m.providerChoices()
		switch msg.String() {
		case "left", "h", "up", "k":
			if w.provIdx > 0 {
				w.provIdx--
			}
		case "right", "l", "down", "j":
			if w.provIdx < len(choices)-1 {
				w.provIdx++
			}
		case "enter":
			name := choices[min(w.provIdx, len(choices)-1)]
			if name == welcomeCustomEntry {
				w.cField, w.savedMsg = 0, ""
				w.focusCustom()
				w.step = welcomeCustom
				break
			}
			if name != m.cfg.Provider {
				m.switchProvider(name)
			}
			w.input.Placeholder = "paste your " + name + " API key · leave empty to skip"
			w.step = welcomeKey
		}

	case welcomeCustom:
		switch msg.String() {
		case "shift+tab":
			w.step = welcomeProvider
		case "up", "k", "ctrl+p":
			if w.cField > 0 {
				w.cField--
				w.focusCustom()
			}
		case "down", "tab", "ctrl+n":
			w.advanceCustomField()
		case "left", "h":
			if w.cField == 2 {
				w.cProto = (w.cProto + 1) % 2
			}
		case "right", "l":
			if w.cField == 2 {
				w.cProto = (w.cProto + 1) % 2
			}
		case "enter":
			switch w.cField {
			case 2: // protocol row: enter cycles, like settings forms
				w.cProto = (w.cProto + 1) % 2
			case 3: // save row
				return m.commitWelcomeCustom()
			default:
				w.advanceCustomField()
			}
		default:
			var cmd tea.Cmd
			switch w.cField {
			case 0:
				w.cName, cmd = w.cName.Update(msg)
			case 1:
				w.cURL, cmd = w.cURL.Update(msg)
			}
			return cmd
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

	case welcomeModel:
		switch msg.String() {
		case "up", "k", "ctrl+p":
			if w.mCur > 0 {
				w.mCur--
			}
		case "down", "j", "ctrl+n":
			if w.mCur < len(w.models)-1 {
				w.mCur++
			}
		case "shift+tab":
			w.step = welcomeKey
		case "enter":
			// Enter always moves on: with a fetched list it picks the
			// cursor's model; while fetching or after a failed fetch it
			// just continues (the ready card points at /settings).
			if !w.fetching && len(w.models) > 0 && w.mCur < len(w.models) {
				m.cfg.SetModel(w.models[w.mCur])
				if err := m.cfg.Save(); err != nil {
					m.lastErr = err.Error()
				}
			}
			w.step = welcomeReady
		}

	case welcomeReady:
		if msg.String() == "enter" {
			m.welcome = nil
		}
	}
	return nil
}

// advanceCustomField moves the custom form's cursor down, wrapping from
// the save row back to the first field.
func (w *welcome) advanceCustomField() {
	w.cField = (w.cField + 1) % 4
	w.focusCustom()
}

// commitWelcomeCustom saves the inline custom provider, activates it,
// and moves to the key step — which endpoints like Ollama can skip with
// an empty key.
func (m *Model) commitWelcomeCustom() tea.Cmd {
	w := m.welcome
	name := strings.TrimSpace(w.cName.Value())
	baseURL := strings.TrimSpace(w.cURL.Value())
	kind := "openai"
	if w.cProto == 1 {
		kind = "anthropic"
	}
	switch {
	case name == "" || baseURL == "":
		w.savedMsg = "✗ name and base url are required"
		return nil
	case config.IsBuiltinProvider(name):
		w.savedMsg = "✗ " + name + " is built-in — pick another name"
		return nil
	}
	if m.providerNameTaken(name, "") {
		w.savedMsg = "✗ a provider named " + name + " already exists"
		return nil
	}
	if m.cfg.CustomProviders == nil {
		m.cfg.CustomProviders = map[string]config.CustomProvider{}
	}
	m.cfg.CustomProviders[name] = config.CustomProvider{Kind: kind, BaseURL: baseURL}
	m.switchProvider(name)
	w.input.Placeholder = "paste your " + name + " API key · leave empty if it needs none"
	w.savedMsg = "✓ provider " + name + " added"
	w.step = welcomeKey
	return nil
}

// commitWelcomeKey saves the pasted key and moves on. An empty key is
// not an error: the walkthrough still advances, and the pre-flight check
// points at /settings if a turn is attempted. When the provider has no
// model yet (khateway, customs — only the endpoint knows its models),
// the next step fetches the endpoint's list so the user picks one right
// here instead of detouring through /settings.
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
	if m.cfg.Model() != "" {
		w.step = welcomeReady
		return nil
	}
	w.step = welcomeModel
	w.models, w.mCur, w.fetching, w.fetchErr = nil, 0, true, ""
	return m.fetchModelsCmd()
}

// indexOf returns i's position in xs, or -1.
func indexOf(xs []string, x string) int {
	for i, v := range xs {
		if v == x {
			return i
		}
	}
	return -1
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
			"  " + pickSel.Render("·") + " answers stream from Anthropic, OpenAI, khateway, or your own endpoints",
			"  " + pickSel.Render("·") + " every session is saved; resume with khode --resume",
			"",
			"setup takes a minute: pick a provider, paste a key.",
		}, "\n")
	case welcomeProvider:
		title = "◆ pick a provider"
		var rows []string
		for i, name := range m.providerChoices() {
			cur := "  "
			if i == w.provIdx {
				cur = "❯ "
			}
			line := name
			switch {
			case name == welcomeCustomEntry:
				line = dimStyle.Render("add a custom provider — Ollama, OpenRouter, any OpenAI-compatible URL")
			case strings.EqualFold(name, "khateway"):
				line += dimStyle.Render("  self-hosted router · one key, every upstream model")
				if u := m.cfg.BaseURL(name); u != "" {
					line += dimStyle.Render("  " + clip(u, 24))
				}
			case !config.IsBuiltinProvider(name):
				line += dimStyle.Render("  " + clip(m.cfg.CustomProviders[name].BaseURL, 30))
			}
			if name == m.cfg.Provider && name != welcomeCustomEntry {
				line += "  " + okStyle.Render("●")
			}
			rows = append(rows, cur+line)
		}
		body = strings.Join(rows, "\n") + "\n\n" +
			dimStyle.Render("  keys are stored per provider; you can switch any time.")
	case welcomeCustom:
		title = "◆ add a custom provider"
		proto := "openai" + dimStyle.Render("  · <base>/models  ←/→ cycle")
		if w.cProto == 1 {
			proto = "anthropic" + dimStyle.Render("  · <base>/v1/models  ←/→ cycle")
		}
		cur1, cur2, cur3 := "  ", "  ", "  "
		switch w.cField {
		case 0:
			cur1 = "❯ "
		case 1:
			cur2 = "❯ "
		case 2:
			cur3 = "❯ "
		}
		body = strings.Join([]string{
			cur1 + "  " + fmt.Sprintf("%-9s", "name") + w.cName.View(),
			cur2 + "  " + fmt.Sprintf("%-9s", "base url") + w.cURL.View(),
			cur3 + "  " + fmt.Sprintf("%-9s", "protocol") + proto,
			"",
			dimStyle.Render("  the provider activates right away; its key can stay empty."),
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
	case welcomeModel:
		title = "◆ pick a model"
		switch {
		case w.fetching:
			body = "  fetching the " + m.cfg.Provider + " model list…"
		case w.fetchErr != "":
			body = strings.Join([]string{
				"  couldn't reach " + m.cfg.Provider + ":",
				"  " + dimStyle.Render(w.fetchErr),
				"",
				dimStyle.Render("  enter to continue — pick a model later with /settings → model"),
			}, "\n")
		case len(w.models) == 0:
			body = dimStyle.Render("  the endpoint listed no models · enter to continue, /settings → model adds one")
		default:
			const windowH = 10
			start := 0
			if len(w.models) > windowH {
				start = min(max(0, w.mCur-windowH/2), len(w.models)-windowH)
			}
			var rows []string
			for i := start; i < min(len(w.models), start+windowH); i++ {
				cur := "  "
				if i == w.mCur {
					cur = "❯ "
				}
				rows = append(rows, cur+w.models[i])
			}
			body = strings.Join(rows, "\n")
			if len(w.models) > windowH {
				body += "\n\n" + dimStyle.Render(fmt.Sprintf("  model %d of %d · ↑/↓ to scroll", w.mCur+1, len(w.models)))
			}
		}
	case welcomeReady:
		title = "◆ you're set"
		rows := []string{
			"try asking khode:",
			"",
			"  " + userStyle.Render("summarize what this repo does"),
			"  " + userStyle.Render("find and fix the failing test"),
			"",
		}
		if mo := m.cfg.Model(); mo != "" {
			rows = append(rows, "  model: "+statusStyle.Render(mo), "")
		}
		if m.cfg.Model() == "" {
			rows = append(rows,
				"  "+pickSel.Render("next:")+" open /settings → model and pick one from "+
					m.cfg.Provider+" ("+keyHint("f", "fetches the list")+")",
				"")
		}
		rows = append(rows,
			dimStyle.Render("  /help commands · /settings configuration · esc stops a stream"))
		body = strings.Join(rows, "\n")
	}

	var footer string
	switch w.step {
	case welcomeIntro:
		footer = keyHint("enter", "start setup") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
	case welcomeProvider:
		footer = keyHint("←/→", "choose") + dimStyle.Render("  ·  ") + keyHint("enter", "continue") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
	case welcomeCustom:
		footer = keyHint("tab", "next field") + dimStyle.Render("  ·  ") + keyHint("←/→", "protocol") + dimStyle.Render("  ·  ") + keyHint("enter", "save") + dimStyle.Render("  ·  ") + keyHint("shift+tab", "back")
	case welcomeKey:
		footer = keyHint("enter", "save") + dimStyle.Render("  ·  ") + keyHint("shift+tab", "back") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
	case welcomeModel:
		switch {
		case w.fetching:
			footer = dimStyle.Render("fetching…") + dimStyle.Render("  ·  ") + keyHint("enter", "skip for now") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
		case w.fetchErr != "" || len(w.models) == 0:
			footer = keyHint("enter", "continue") + dimStyle.Render("  ·  ") + keyHint("shift+tab", "back") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
		default:
			footer = keyHint("↑/↓", "choose") + dimStyle.Render("  ·  ") + keyHint("enter", "use model") + dimStyle.Render("  ·  ") + keyHint("shift+tab", "back") + dimStyle.Render("  ·  ") + keyHint("esc", "skip")
		}
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
