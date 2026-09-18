package ui

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"khode/internal/agent"
	"khode/internal/llm"
	"khode/internal/perm"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/termenv"
)

// TestDumpViews renders every surface at a fixed size into the ui dump
// dir (set DUMP_DIR) so the frames can be inspected outside the repo.
// Skipped unless DUMP_DIR is set.
func TestDumpViews(t *testing.T) {
	dir := os.Getenv("DUMP_DIR")
	if dir == "" {
		t.Skip("DUMP_DIR not set")
	}
	// go test output is not a tty, so lipgloss would strip all color;
	// force truecolor for the frames.
	lipgloss.SetColorProfile(termenv.TrueColor)

	// resize runs the real Update chain so width/height land on the
	// returned model.
	resize := func(m Model) Model {
		next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
		return next.(Model)
	}

	write := func(name string, s string) {
		re := regexp.MustCompile(`\x1b\[[0-9;:]*[a-zA-Z]`)
		plain := re.ReplaceAllString(s, "")
		os.WriteFile(filepath.Join(dir, name), []byte(s), 0o644)
		os.WriteFile(filepath.Join(dir, strings.TrimSuffix(name, ".txt")+".plain.txt"), []byte(plain), 0o644)
	}

	// --- main chat with a bit of history ---
	chat := resize(newTestModel(t))
	chat.messages = append(chat.messages,
		uiMessage{role: llm.RoleUser, raw: "summarize what this repo does", history: true},
		uiMessage{role: llm.RoleAssistant, kind: kindThinking, raw: "scanning the layout first", history: true},
		uiMessage{role: llm.RoleAssistant, kind: kindToolCall,
			raw: formatToolCall(llm.ToolCall{Name: "glob", Input: json.RawMessage(`{"pattern":"**/*.go"}`)}), history: true},
		uiMessage{role: llm.RoleTool, kind: kindToolResult, raw: "cmd/khode/main.go\ninternal/ui/app.go\n+12 more lines", history: true},
		uiMessage{role: llm.RoleAssistant, raw: "This is **khode** — a terminal coding agent with:\n\n- provider-agnostic streaming\n- tool use behind permissions", history: true},
		uiMessage{role: "system", raw: "mode → accept-edits · file changes run freely; commands still ask"},
	)
	chat.renderAll()
	write("chat.txt", chat.View())

	// streaming state: elapsed timer + cursor + live border
	st := resize(newTestModel(t))
	st.streaming = true
	st.turnStart = time.Now().Add(-65 * time.Second)
	st.messages = append(st.messages, uiMessage{role: llm.RoleAssistant, kind: kindText, streaming: true, history: true})
	st.partial.WriteString("working on it, one delta at a")
	st.messages[len(st.messages)-1].raw = st.partial.String()
	st.ctxIn, st.ctxOut = 120_000, 8_000
	st.renderAll()
	write("chat-streaming.txt", st.View())

	// --- walkthrough ---
	wm := resize(newSettingsModel(t))
	wm.OpenWelcome()
	write("welcome-intro.txt", wm.View())
	wm = pressKeys(wm, "enter")
	write("welcome-provider.txt", wm.View())

	// --- settings rows ---
	sm := resize(newSettingsModel(t))
	sm.OpenSettings(rowProvider)
	write("settings.txt", sm.View())

	// --- provider list ---
	pm := resize(newSettingsModel(t))
	pm.OpenSettings(rowProvider)
	pm = pressKeys(pm, "enter")
	write("settings-providers.txt", pm.View())

	// --- session picker ---
	km := resize(newTestModel(t))
	km.OpenPicker([]agent.Info{
		{Name: "khode-fixes", Messages: 42, Path: "/tmp/x", ModTime: time.Now().Add(-3 * time.Minute)},
		{Name: "refactor-llm", Messages: 7, Path: "/tmp/y", ModTime: time.Now().Add(-26 * time.Hour)},
	})
	write("picker.txt", km.View())

	// --- permission dialog ---
	dm := resize(newTestModel(t))
	req := agent.Request{
		Call:    llm.ToolCall{ID: "c1", Name: "edit", Input: json.RawMessage(`{"path":"internal/ui/app.go"}`)},
		Risk:    perm.RiskWrite,
		Preview: "@@ -12,7 +12,9 @@\n-important line\n+changed line\n+added line\n context line",
	}
	dm.perm = &req
	write("perm.txt", dm.View())

	// --- plan dialog ---
	pl := resize(newTestModel(t))
	preq := agent.Request{Kind: agent.KindPlan, Preview: "# the plan\n\n1. add the design system\n2. restyle the chat\n3. restyle overlays\n4. verify"}
	pl.perm = &preq
	write("plan.txt", pl.View())

	// sanity: the chat frame carries truecolor styling (lipgloss rounds
	// the hex values by a step, so exact channels aren't asserted).
	raw, _ := os.ReadFile(filepath.Join(dir, "chat.txt"))
	if !strings.Contains(string(raw), "38;2;") {
		t.Error("chat frame has no truecolor escapes")
	}
	if !strings.Contains(string(plain(t, dir, "chat.txt")), "─") {
		t.Error("chat frame missing the header rule")
	}

	// the wordmark must come out gradient-styled, not passed through
	// plain (a parse failure inside gradient degrades silently).
	if g := gradient("khode", "#4ADE80", "#2DD4BF"); !strings.Contains(g, "\x1b[1;38;2;") {
		t.Errorf("gradient produced no per-rune colors: %q", g)
	}
}

func plain(t *testing.T, dir, name string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, strings.TrimSuffix(name, ".txt")+".plain.txt"))
	if err != nil {
		return ""
	}
	return string(b)
}
