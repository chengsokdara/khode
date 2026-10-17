package ui

import (
	"encoding/json"
	"testing"
	"time"

	"khode/internal/agent"
	"khode/internal/config"
	"khode/internal/khateway"
	"khode/internal/llm"
	"khode/internal/perm"

	tea "charm.land/bubbletea/v2"
)

// TestKeyPressStrings pins the synthesized keypresses: footer chips and
// row activation route through handleKey, which matches on String(), so
// a drift here would silently unhook every clickable chip.
func TestKeyPressStrings(t *testing.T) {
	cases := map[string]string{
		"enter":     keyPress("enter").String(),
		"esc":       keyPress("esc").String(),
		"tab":       keyPress("tab").String(),
		"shift+tab": keyPress("shift+tab").String(),
		"space":     keyPress("space").String(),
		"y":         keyPress("y").String(),
		"n":         keyPress("n").String(),
		"o":         keyPress("o").String(),
		"f":         keyPress("f").String(),
	}
	for name, got := range cases {
		if got != name {
			t.Errorf("keyPress(%q).String() = %q", name, got)
		}
	}
}

// TestListWindowAtStagesRegions checks the region bookkeeping of the
// windowed dialog lists: one row region per visible entry at its drawn
// row (offset by the cut notes), plus the paging notes themselves.
func TestListWindowAtStagesRegions(t *testing.T) {
	resetRegions()
	defer resetRegions()

	rows := make([]string, 20)
	got := listWindowAt(rows, 3, 5, 2)
	if len(got) != 7 { // ↑ note, five rows, ↓ note
		t.Fatalf("windowed rows = %d, want 7", len(got))
	}
	if len(pending) != 7 {
		t.Fatalf("staged regions = %d, want 7", len(pending))
	}
	if pending[0].kind != clickMoreUp || pending[0].row != 2 {
		t.Errorf("first region = %+v, want the ↑ note at row 2", pending[0])
	}
	for i, want := range []int{1, 2, 3, 4, 5} {
		r := pending[i+1]
		if r.kind != clickRow || r.idx != want || r.row != 3+i {
			t.Errorf("region %d = %+v, want row %d idx %d", i, r, 3+i, want)
		}
	}
	if last := pending[6]; last.kind != clickMoreDown || last.row != 8 || last.idx != 5 {
		t.Errorf("last region = %+v, want the ↓ note at row 8 paging by 5", last)
	}

	// A list that fits still records its rows, without any notes.
	resetRegions()
	got = listWindowAt(rows[:3], 0, 5, 4)
	if len(got) != 3 || len(pending) != 3 {
		t.Fatalf("short list: rows=%d regions=%d, want 3 and 3", len(got), len(pending))
	}
	if pending[0].row != 4 || pending[0].idx != 0 {
		t.Errorf("first short-list region = %+v, want row 4 idx 0", pending[0])
	}
}

// TestPlaceDialogResolvesRegions checks the flush from content
// coordinates to screen coordinates: a 100×40 frame centers an 8×6 box
// at (46,17), content starts three columns and two rows in, and the
// footer pin lands on the box's last content row.
func TestPlaceDialogResolvesRegions(t *testing.T) {
	resetRegions()
	defer resetRegions()

	stage(relRegion{row: rowFooter, kind: clickKey, key: keyPress("enter")})
	stage(relRegion{row: 0, x: 2, w: 7, kind: clickRow, idx: 3})
	placeDialog(100, 40, dialogBorder.Render("ab\ncd"))

	if len(regions) != 2 {
		t.Fatalf("regions = %d, want 2", len(regions))
	}
	footer, row := regions[0], regions[1]
	if footer.x != 49 || footer.y != 20 || footer.w != 51 {
		t.Errorf("footer region = %+v, want x49 y20 full width", footer)
	}
	if row.x != 51 || row.y != 19 || row.w != 7 || row.idx != 3 {
		t.Errorf("row region = %+v, want x51 y19 w7 idx3", row)
	}
	if r, ok := regionAt(51, 19); !ok || r.kind != clickRow {
		t.Errorf("regionAt(51,19) = %+v %v, want the row region", r, ok)
	}
	if r, ok := regionAt(49, 20); !ok || r.kind != clickKey {
		t.Errorf("regionAt(49,20) = %+v %v, want the footer chip", r, ok)
	}
	if _, ok := regionAt(0, 0); ok {
		t.Error("regionAt(0,0) hit, want a miss outside every region")
	}
}

// clickAt renders the model's frame and sends a left click on the first
// region satisfying pred — the same order the real loop runs in (the
// registry always describes the last rendered frame).
func clickAt(t *testing.T, m Model, pred func(region) bool) Model {
	t.Helper()
	m.View()
	for _, r := range regions {
		if pred(r) {
			next, _ := m.Update(tea.MouseClickMsg(tea.Mouse{
				X: r.x + r.w/2, Y: r.y, Button: tea.MouseLeft,
			}))
			return next.(Model)
		}
	}
	t.Fatal("no click region matched")
	return m
}

func sizedModel(t *testing.T) Model {
	t.Helper()
	m := newTestModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	return next.(Model)
}

// The header's mode chip is a button: clicking it walks the permission
// mode exactly like shift+tab.
func TestModeChipClickCyclesMode(t *testing.T) {
	m := sizedModel(t)
	if m.mode() != perm.ModeAsk {
		t.Fatalf("starting mode = %s, want ask", m.mode())
	}
	m = clickAt(t, m, func(r region) bool { return r.kind == clickModeChip })
	if m.mode() != perm.Next(perm.ModeAsk) {
		t.Errorf("mode after chip click = %s, want %s", m.mode(), perm.Next(perm.ModeAsk))
	}
}

// The setup banner's slash commands are clickable: /welcome opens the
// walkthrough the way typing it would.
func TestSetupBannerCommandClick(t *testing.T) {
	m := sizedModel(t) // no key anywhere: the banner shows
	if _, rel := m.setupHint(); len(rel) == 0 {
		t.Fatal("unconfigured model rendered no banner command regions")
	}
	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickHintCmd && r.idx == hintWelcome
	})
	if m.welcome == nil {
		t.Error("clicking /welcome in the banner did not open the walkthrough")
	}
}

// List rows follow the select-then-activate convention: the first click
// moves the cursor, clicking the row under the cursor applies it.
func TestModePickerRowClickSelectThenApply(t *testing.T) {
	m := sizedModel(t)
	m.openModePicker() // cursor rests on the active mode (ask, index 1)
	if m.modePick == nil || m.modePick.cursor != 1 {
		t.Fatalf("picker open state = %+v", m.modePick)
	}

	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickRow && r.idx == 0
	})
	if m.modePick == nil || m.modePick.cursor != 0 {
		t.Fatalf("first click did not move the cursor: %+v", m.modePick)
	}
	if m.mode() != perm.ModeAsk {
		t.Errorf("first click changed the mode to %s", m.mode())
	}

	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickRow && r.idx == 0
	})
	if m.modePick != nil {
		t.Error("second click did not apply and close the picker")
	}
	if m.mode() != perm.ModePlan {
		t.Errorf("mode after activation = %s, want plan", m.mode())
	}
}

// Footer chips press their key: the approval dialog's deny chip answers
// the question like typing n.
func TestPermFooterChipDenies(t *testing.T) {
	m := sizedModel(t)
	m.streaming = true
	m.events = make(chan llm.Event) // never delivers; the bridge is the only traffic

	call := llm.ToolCall{ID: "c1", Name: "edit", Input: json.RawMessage(`{"path":"a.go"}`)}
	approved := startDialog(&m, call, perm.RiskWrite)
	m = pumpUntilDialog(t, m)

	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickKey && r.key.String() == "n"
	})
	if m.perm != nil {
		t.Error("deny chip left the approval dialog open")
	}
	// The approver goroutine may need a moment to forward the answer it
	// just received.
	select {
	case ok := <-approved:
		if ok {
			t.Error("deny chip approved the call")
		}
	case <-time.After(2 * time.Second):
		t.Error("deny chip did not answer the waiting approver")
	}
}

// Clicking a /tools row toggles the tool at once — checkbox semantics.
func TestToolsRowClickToggles(t *testing.T) {
	m := sizedModel(t)
	m.openTools()
	if len(m.toolsPanel.names) == 0 {
		t.Fatal("no tools registered in the test model")
	}
	name := m.toolsPanel.names[0]
	before := m.tools.Enabled(name)
	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickToggle && r.idx == 0
	})
	if m.tools.Enabled(name) == before {
		t.Errorf("tool %s still enabled=%v after the click", name, before)
	}
	if m.toolsPanel.cursor != 0 {
		t.Errorf("cursor = %d, want 0 (the clicked row)", m.toolsPanel.cursor)
	}
}

// The completion popup follows the row convention too: clicking a row
// that is not under the cursor only moves it, and the second click runs
// the command.
func TestPopupRowClickRuns(t *testing.T) {
	m := sizedModel(t)
	next, _ := m.Update(tea.KeyPressMsg{Code: '/', Text: "/"})
	m = next.(Model)
	m.syncPopup()
	if m.popup == nil {
		t.Fatal("typing / did not open the completion popup")
	}
	if m.popup.cursor != 0 {
		t.Fatalf("popup cursor = %d, want 0", m.popup.cursor)
	}

	// Row 1 (/login — the cursor rests on row 0): the first click only
	// selects.
	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickRow && r.idx == 1
	})
	if m.popup == nil || m.popup.cursor != 1 {
		t.Fatalf("first click did not move the cursor: %+v", m.popup)
	}
	// The second click runs it: /login opens the sign-in dialog.
	m = clickAt(t, m, func(r region) bool {
		return r.kind == clickRow && r.idx == 1
	})
	if m.popup != nil {
		t.Error("second click did not run the command and close the popup")
	}
	if m.deviceLogin == nil {
		t.Error("clicking /login did not open the sign-in dialog")
	}
}

// TestEverySurfaceStagesRegions sweeps every surface the app can render
// and asserts each one registers click targets that stay inside the
// frame — the closest a headless test gets to "every button is
// clickable, and none of them point off screen".
func TestEverySurfaceStagesRegions(t *testing.T) {
	const width, height = 100, 30
	sweep := []struct {
		name string
		open func(m *Model)
	}{
		{"chat", func(m *Model) {}},
		{"perm", func(m *Model) {
			m.perm = &agent.Request{Kind: agent.KindTool, Risk: perm.RiskWrite,
				Call: llm.ToolCall{ID: "c1", Name: "edit", Input: json.RawMessage(`{}`)}}
		}},
		{"device login", func(m *Model) {
			m.deviceLogin = &deviceLogin{code: khateway.Code{
				UserCode:                "ABCD-EFGH",
				VerificationURIComplete: "https://khateway.example/device?code=x",
			}}
		}},
		{"welcome provider", func(m *Model) {
			m.OpenWelcome()
			m.welcome.step = welcomeProvider
		}},
		{"welcome custom", func(m *Model) {
			m.OpenWelcome()
			m.welcome.step = welcomeCustom
		}},
		{"welcome khateway", func(m *Model) {
			m.OpenWelcome()
			m.welcome.step = welcomeKhateway
		}},
		{"welcome model", func(m *Model) {
			m.OpenWelcome()
			m.welcome.step = welcomeModel
			m.welcome.models = []string{"m1", "m2"}
		}},
		{"settings rows", func(m *Model) { m.OpenSettings(rowProvider) }},
		{"settings editor", func(m *Model) {
			m.OpenSettings(rowProvider)
			m.settings.cursor = int(rowMaxTokens)
			m.openEditor(rowMaxTokens)
		}},
		{"settings providers", func(m *Model) {
			m.OpenSettings(rowProvider)
			m.settings.view = viewProviderList
		}},
		{"settings models", func(m *Model) {
			m.OpenSettings(rowProvider)
			m.settings.view = viewModels
			m.settings.models = &modelPicker{provider: "test", list: []string{"a", "b"}}
		}},
		{"settings mcp", func(m *Model) {
			m.cfg.MCPServers = map[string]config.MCPServer{"s1": {Command: "echo"}}
			m.OpenSettings(rowMCP)
			m.settings.view = viewMCPList
		}},
		{"settings form", func(m *Model) {
			m.OpenSettings(rowMCP)
			m.openMCPForm("")
		}},
		{"tools", func(m *Model) { m.openTools() }},
		{"mcp panel", func(m *Model) {
			m.cfg.MCPServers = map[string]config.MCPServer{"s1": {Command: "echo"}}
			m.openMCPPanel()
		}},
		{"mcp form", func(m *Model) {
			m.openMCPPanel()
			m.mcpPanel.form = m.newMCPServerForm("")
			m.mcpPanel.form.focus()
		}},
		{"sessions", func(m *Model) { m.OpenPicker([]agent.Info{{Name: "s1"}}) }},
		{"model dialog", func(m *Model) { m.openModelPick() }},
		{"mode picker", func(m *Model) { m.openModePicker() }},
		{"completion", func(m *Model) {
			m.textarea.SetValue("/")
			m.syncPopup()
		}},
	}
	for _, tc := range sweep {
		t.Run(tc.name, func(t *testing.T) {
			m := sizedModel(t)
			tc.open(&m)
			m.View()
			if len(regions) == 0 {
				t.Fatalf("%s rendered no click regions", tc.name)
			}
			for _, r := range regions {
				if r.x < 0 || r.y < 0 || r.x+r.w > width || r.y >= height {
					t.Errorf("region out of frame: %+v (frame %dx%d)", r, width, height)
				}
			}
		})
	}
}
