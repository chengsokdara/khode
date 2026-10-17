package ui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"time"

	"khode/internal/khateway"
	"khode/internal/llm"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
)

// deviceLogin is the khateway device-flow sign-in overlay (RFC 8628),
// opened by /login, the walkthrough's khateway step, and the settings
// key choice. It mints a request, shows the verification URL + code,
// and polls in the background; approving in the portal grants a
// personal API key, which lands in auth.json and switches the active
// provider to khateway. The dialog renders above (and answers the
// keys before) every surface that can open it. Esc cancels; a closed
// dialog's in-flight poll result is dropped and the tick loop dies
// with it.
type deviceLogin struct {
	baseURL string        // khateway base (config or the default endpoint)
	code    khateway.Code // minted request; empty until Start succeeds
	status  string        // transient line (minting, poll errors, expiry)
	expired bool          // stop polling — the request died (user can esc)
}

// openDeviceLogin starts the flow. The base URL comes from the same
// resolution chat uses, so KHATEWAY_BASE_URL and config.base_urls.khateway
// are honored.
func (m *Model) openDeviceLogin() tea.Cmd {
	_, baseURL := m.cfg.Credentials(m.auth, llm.ProviderKhateway)
	m.deviceLogin = &deviceLogin{baseURL: baseURL, status: "minting a sign-in request…"}
	name := "khode"
	if host, err := os.Hostname(); err == nil && host != "" {
		name = "khode on " + host
	}
	dl := m.deviceLogin
	return func() tea.Msg {
		code, err := khateway.Start(context.Background(), nil, dl.baseURL, name)
		return deviceCodeMsg{code: code, err: err}
	}
}

// --- messages ---------------------------------------------------------------

type deviceCodeMsg struct {
	code khateway.Code
	err  error
}

// devicePollTickMsg fires when the poll interval elapses; the handler then
// issues the actual poll command (network runs off the UI goroutine).
type devicePollTickMsg struct{}

type devicePollResultMsg struct {
	res khateway.Result
	err error
}

// khatewayModelMsg carries the post-sign-in model-list fetch used to pick
// a working default model.
type khatewayModelMsg struct {
	models []string
	err    error
}

// pollTick schedules the next poll at the interval the mint response named.
func (m *Model) pollTick() tea.Cmd {
	interval := time.Duration(m.deviceLogin.code.Interval) * time.Second
	if interval <= 0 {
		interval = 5 * time.Second
	}
	return tea.Tick(interval, func(time.Time) tea.Msg { return devicePollTickMsg{} })
}

// --- update -----------------------------------------------------------------

func (m *Model) deviceLoginKey(msg tea.KeyMsg) tea.Cmd {
	switch msg.String() {
	case "ctrl+c":
		m.stopStream()
		return tea.Quit
	case "esc":
		m.deviceLogin = nil
	case "o", "O":
		openBrowser(m.deviceLogin.code.VerificationURIComplete)
	}
	return nil
}

func (m *Model) applyDeviceCode(msg deviceCodeMsg) tea.Cmd {
	if msg.err != nil {
		m.deviceLogin.status = clip("sign-in failed: "+msg.err.Error(), 56) + dimStyle.Render("  · esc to close")
		return nil
	}
	m.deviceLogin.code = msg.code
	m.deviceLogin.status = ""
	openBrowser(msg.code.VerificationURIComplete) // best effort; the URL is on screen either way
	return m.pollTick()
}

func (m *Model) pollDeviceCmd() tea.Cmd {
	dl := m.deviceLogin
	return func() tea.Msg {
		res, err := khateway.Poll(context.Background(), nil, dl.baseURL, dl.code.DeviceCode)
		return devicePollResultMsg{res: res, err: err}
	}
}

// applyDevicePoll handles one poll outcome: keep waiting (schedule the next
// poll), stop with a message, or finish the sign-in.
func (m *Model) applyDevicePoll(msg devicePollResultMsg) tea.Cmd {
	switch {
	case errors.Is(msg.err, khateway.ErrPending):
		return m.pollTick()
	case errors.Is(msg.err, khateway.ErrExpired):
		m.deviceLogin.status = clip("sign-in request expired or already used", 56) +
			dimStyle.Render("  · esc to close · restart with /login")
		m.deviceLogin.expired = true
		return nil
	case errors.Is(msg.err, khateway.ErrDenied):
		m.deviceLogin = nil
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: "khateway sign-in was denied in the browser"})
		return m.flush()
	case msg.err != nil:
		// Transient (network, slow_down): keep polling, surface the cause.
		m.deviceLogin.status = clip("poll: "+msg.err.Error(), 56)
		return m.pollTick()
	default:
		return m.finishDeviceLogin(msg.res)
	}
}

// finishDeviceLogin banks the granted key: stored in auth.json, khateway
// becomes the active provider (rebuilt so the next turn carries the key),
// and a model list fetch picks a working default. The dialog closes with a
// system line saying who signed in and how much credit they have.
func (m *Model) finishDeviceLogin(res khateway.Result) tea.Cmd {
	m.auth.SetKey(llm.ProviderKhateway, res.AccessToken)
	if err := m.auth.Save(); err != nil {
		m.deviceLogin = nil
		m.lastErr = err.Error()
		return nil
	}
	m.deviceLogin = nil
	if m.cfg.Provider != llm.ProviderKhateway {
		m.switchProvider(llm.ProviderKhateway)
	} else {
		m.rebuildProvider()
	}
	// The first-run walkthrough's khateway step continues to its own
	// model picker — the fresh key makes the fetch work — instead of
	// auto-picking in chat behind the walkthrough.
	if w := m.welcome; w != nil && w.step == welcomeKhateway {
		w.step = welcomeModel
		w.models, w.mCur, w.fetching, w.fetchErr = nil, 0, true, ""
		return m.fetchModelsCmd()
	}
	if m.cfg.Model() == "" {
		return m.khatewayAutoModelCmd()
	}
	m.messages = append(m.messages, uiMessage{role: "system",
		raw: fmt.Sprintf("signed in to khateway as %s · $%.2f credit · model %s", res.Email, res.BalanceUSD, m.modelLabel())})
	return m.flush()
}

// khatewayAutoModelCmd fetches the freshly authorized endpoint's model list.
func (m *Model) khatewayAutoModelCmd() tea.Cmd {
	proto := m.cfg.ProviderProtocol(llm.ProviderKhateway)
	key, baseURL := m.cfg.Credentials(m.auth, llm.ProviderKhateway)
	return func() tea.Msg {
		models, err := llm.FetchModels(context.Background(), proto, key, baseURL)
		return khatewayModelMsg{models: models, err: err}
	}
}

func (m *Model) applyKhatewayModel(msg khatewayModelMsg) tea.Cmd {
	switch {
	case msg.err != nil:
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: "signed in to khateway · model fetch failed (" + clip(msg.err.Error(), 40) + ") — pick one with /model"})
	case len(msg.models) == 0:
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: "signed in to khateway · the gateway listed no models — add one with /model"})
	default:
		m.cacheModelChoices(llm.ProviderKhateway, msg.models)
		m.cfg.SetModel(msg.models[0])
		m.saveSettings("model → " + m.cfg.Model())
		m.messages = append(m.messages, uiMessage{role: "system",
			raw: fmt.Sprintf("signed in to khateway · model %s", m.cfg.Model())})
	}
	return m.flush()
}

// --- view -------------------------------------------------------------------

func (m *Model) deviceLoginView() string {
	dl := m.deviceLogin
	rows := []string{dialogTitle("khateway sign-in", ""), ""}
	urlAt := -1 // content row of the verification URL, for its click region

	if dl.code.UserCode == "" {
		rows = append(rows, dimStyle.Render(clip(dl.status, 60)), "")
	} else {
		rows = append(rows,
			dimStyle.Render("Open this link and approve the request:"))
		urlAt = len(rows)
		rows = append(rows,
			"  "+exampleStyle.Render(dl.code.VerificationURIComplete),
			"",
			dimStyle.Render("or enter the code shown there:"),
			"  "+pickSel.Render(dl.code.UserCode),
			"",
		)
		if dl.status != "" {
			rows = append(rows, warnStyle.Render(clip(dl.status, 60)))
		} else if !dl.expired {
			rows = append(rows, dimStyle.Render("· waiting for approval in your browser…"))
		}
		rows = append(rows, "")
	}
	if urlAt >= 0 {
		stage(relRegion{row: urlAt, kind: clickOpenURL})
	}
	footer := newHelpLine().chip("o", "open browser", "o").sep().chip("esc", "cancel", "esc")
	box := dialogBorder.Render(lipgloss.JoinVertical(lipgloss.Left, append(rows, footer.String())...))
	return placeDialog(m.width, m.height, box)
}

// openBrowser best-effort launches the verification URL; failures are
// silent — the URL is on screen regardless.
func openBrowser(url string) {
	if url == "" {
		return
	}
	for _, bin := range []string{"open", "xdg-open"} {
		if path, err := exec.LookPath(bin); err == nil {
			_ = exec.Command(path, url).Start()
			return
		}
	}
}
