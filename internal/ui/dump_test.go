package ui

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"khode/internal/agent"
	"khode/internal/llm"
	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
)

// TestDumpViews renders every surface at a fixed size into the ui dump
// dir (set DUMP_DIR) so the frames can be inspected outside the repo.
// Skipped unless DUMP_DIR is set.
func TestDumpViews(t *testing.T) {
	dir := os.Getenv("DUMP_DIR")
	if dir == "" {
		t.Skip("DUMP_DIR not set")
	}
	// lipgloss v2 renders truecolor escapes unconditionally; color
	// downsampling happens at write time through a colorprofile.Writer,
	// so raw View() content keeps full truecolor regardless of tty.

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

	// --- main chat: history printed into scrollback, live region below ---
	// The fixture is appended BEFORE the resize so the first flush
	// carries the banner and the whole history as one tea.Println chunk.
	chat := newTestModel(t)
	chat.messages = append(chat.messages,
		uiMessage{role: llm.RoleUser, raw: "summarize what this repo does", history: true},
		uiMessage{role: llm.RoleAssistant, kind: kindThinking, raw: "scanning the layout first", history: true},
		uiMessage{role: llm.RoleAssistant, kind: kindToolCall,
			raw: formatToolCall(llm.ToolCall{Name: "glob", Input: json.RawMessage(`{"pattern":"**/*.go"}`)}), history: true},
		uiMessage{role: llm.RoleTool, kind: kindToolResult, raw: "cmd/khode/main.go\ninternal/ui/app.go\n+12 more lines", history: true},
		uiMessage{role: llm.RoleAssistant, raw: "This is **khode** — a terminal coding agent with:\n\n- provider-agnostic streaming\n- tool use behind permissions", history: true},
		uiMessage{role: "system", raw: "mode → accept-edits · file changes run freely; commands still ask"},
	)
	chat = resize(chat)
	write("chat.txt", chat.View().Content) // the full-screen frame

	// streaming state: elapsed timer + cursor + live border; the banner
	// prints, the streaming block stays in the live region.
	st := newTestModel(t)
	st.streaming = true
	st.turnStart = time.Now().Add(-65 * time.Second)
	st.partial.WriteString("working on it, one delta at a")
	st.messages = append(st.messages, uiMessage{role: llm.RoleAssistant, kind: kindText,
		streaming: true, history: true, raw: st.partial.String()})
	st.ctxIn, st.ctxOut = 120_000, 8_000
	st = resize(st)
	write("chat-streaming.txt", st.View().Content)

	// --- walkthrough ---
	wm := resize(newSettingsModel(t))
	wm.OpenWelcome()
	write("welcome-intro.txt", wm.View().Content)
	wm = pressKeys(wm, "enter")
	write("welcome-provider.txt", wm.View().Content)

	// --- settings rows ---
	sm := resize(newSettingsModel(t))
	sm.OpenSettings(rowProvider)
	write("settings.txt", sm.View().Content)

	// --- provider list ---
	pm := resize(newSettingsModel(t))
	pm.OpenSettings(rowProvider)
	pm = pressKeys(pm, "enter")
	write("settings-providers.txt", pm.View().Content)

	// --- session picker ---
	km := resize(newTestModel(t))
	km.OpenPicker([]agent.Info{
		{Name: "khode-fixes", Messages: 42, Path: "/tmp/x", ModTime: time.Now().Add(-3 * time.Minute)},
		{Name: "refactor-llm", Messages: 7, Path: "/tmp/y", ModTime: time.Now().Add(-26 * time.Hour)},
	})
	write("picker.txt", km.View().Content)

	// long list: the sliding window with its cut markers
	lm := newTestModel(t)
	entries := make([]agent.Info, 0, 15)
	for i := range 15 {
		entries = append(entries, agent.Info{
			Name:     fmt.Sprintf("session-%02d", i),
			Messages: i + 1, Path: "/tmp/x", ModTime: time.Now().Add(-time.Duration(i) * time.Hour),
		})
	}
	lm.OpenPicker(entries)
	lm.picker.cursor = 7
	lm = resize(lm)
	write("picker-many.txt", lm.View().Content)

	// --- tools panel ---
	tm := resize(newTestModel(t))
	tm.openTools()
	write("tools.txt", tm.View().Content)
	tm = pressKeys(tm, "down", "down", "down", "down", "down") // bash
	tm = pressKeys(tm, "enter")                                // toggle off
	write("tools-off.txt", tm.View().Content)

	// --- slash-command completion popup ---
	cp := resize(newTestModel(t))
	cp = pressKeys(cp, "/")
	write("popup.txt", cp.View().Content)
	cp = pressKeys(cp, "m", "o")
	write("popup-filtered.txt", cp.View().Content)
	cp = pressKeys(cp, "down")
	write("popup-filtered-cursor.txt", cp.View().Content)

	// --- mode picker (bare /mode) and the mode line above the input ---
	mp := resize(newTestModel(t))
	mp.command("/mode")
	write("mode-picker.txt", mp.View().Content)

	mh := resize(newTestModel(t))
	mh.cfg.PermissionMode = string(perm.ModeAcceptEdits)
	write("mode-hint.txt", mh.View().Content)

	// --- permission dialog ---
	dm := resize(newTestModel(t))
	req := agent.Request{
		Call:    llm.ToolCall{ID: "c1", Name: "edit", Input: json.RawMessage(`{"path":"internal/ui/app.go"}`)},
		Risk:    perm.RiskWrite,
		Preview: "@@ -12,7 +12,9 @@\n-important line\n+changed line\n+added line\n context line",
	}
	dm.perm = &req
	write("perm.txt", dm.View().Content)

	// --- plan dialog ---
	pl := resize(newTestModel(t))
	preq := agent.Request{Kind: agent.KindPlan, Preview: "# the plan\n\n1. add the design system\n2. restyle the chat\n3. restyle overlays\n4. verify"}
	pl.perm = &preq
	write("plan.txt", pl.View().Content)

	// sanity: the chat frame carries truecolor styling (lipgloss rounds
	// the hex values by a step, so exact channels aren't asserted).
	raw, _ := os.ReadFile(filepath.Join(dir, "chat.txt"))
	if !strings.Contains(string(raw), "38;2;") {
		t.Error("chat frame has no truecolor escapes")
	}
	// The banner is a system message rendered in the viewport.
	if !strings.Contains(string(plain(t, dir, "chat.txt")), "─") {
		t.Error("frame missing the header rule")
	}
	if got := plain(t, dir, "chat.txt"); !strings.Contains(got, "❯") {
		t.Errorf("chat frame missing the input prompt: %q", got)
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
