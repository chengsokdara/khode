package ui

import (
	"errors"
	"reflect"
	"strings"
	"testing"

	"khode/internal/config"

	tea "charm.land/bubbletea/v2"
)

func TestFilterModels(t *testing.T) {
	all := []string{"claude-sonnet-4-5", "claude-haiku-4-5", "GPT-5-Mini"}
	table := []struct {
		name   string
		filter string
		want   []string
	}{
		{"empty keeps everything in order", "", all},
		{"case-insensitive substring", "HAIKU", []string{"claude-haiku-4-5"}},
		{"infix match across case", "5-m", []string{"GPT-5-Mini"}},
		{"no match empties the list", "llama", []string{}},
		{"padded filter is trimmed", "  opus  ", []string{}},
	}
	for _, tc := range table {
		if got := filterModels(all, tc.filter); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: filterModels = %v, want %v", tc.name, got, tc.want)
		}
	}
	// The unfiltered result must be a copy: callers mutate p.all freely.
	got := filterModels(all, "")
	got[0] = "mutated"
	if all[0] != "claude-sonnet-4-5" {
		t.Error("filterModels aliased the input slice")
	}
}

func TestModelPickOpenFilterSelect(t *testing.T) {
	m := newSettingsModel(t)
	m.cfg.SetModelChoices("anthropic", []string{
		"claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1", "future-model",
	})
	m.cfg.SetModel("claude-haiku-4-5")

	// A cached list opens without a fetch and puts the cursor on the
	// active model.
	if cmd := m.command("/model"); cmd != nil {
		t.Fatal("opening with a cached list scheduled a fetch")
	}
	if m.modelPick == nil {
		t.Fatal("bare /model did not open the picker")
	}
	if p := m.modelPick; p.fetching || len(p.list) != 4 || p.list[p.cursor] != "claude-haiku-4-5" {
		t.Fatalf("open state: fetching=%v cursor=%d list=%v", p.fetching, p.cursor, p.list)
	}

	// Printable keys filter (j/k included — the one picker without vim
	// keys); the cursor re-lands on the active model when it survives.
	m = pressKeys(m, "c", "l")
	if p := m.modelPick; p.filter != "cl" || len(p.list) != 3 || p.list[p.cursor] != "claude-haiku-4-5" {
		t.Fatalf("after \"cl\": filter=%q list=%v cursor=%d", p.filter, p.list, p.cursor)
	}

	// Filtering away the active model parks the cursor at the top.
	m = pressKeys(m, "a", "d")
	if p := m.modelPick; p.filter != "clad" || len(p.list) != 0 || p.cursor != 0 {
		t.Fatalf("after \"clad\": filter=%q list=%v cursor=%d", p.filter, p.list, p.cursor)
	}
	// Backspace un-filters; the cursor re-lands on the active model.
	m = pressKeys(m, "backspace")
	if p := m.modelPick; p.filter != "cla" || len(p.list) != 3 || p.list[p.cursor] != "claude-haiku-4-5" {
		t.Fatalf("after trim to \"cla\": filter=%q list=%v cursor=%d", p.filter, p.list, p.cursor)
	}

	// enter commits the highlighted model: dialog closed, config saved,
	// chat notice printed.
	m = pressKeys(m, "enter")
	if m.modelPick != nil {
		t.Fatal("picker open after enter")
	}
	if m.cfg.Model() != "claude-haiku-4-5" {
		t.Errorf("model after enter = %q, want claude-haiku-4-5", m.cfg.Model())
	}
	if last := m.messages[len(m.messages)-1].raw; !strings.Contains(last, "model → test/claude-haiku-4-5") {
		t.Errorf("enter notice = %q", last)
	}
	cfg, err := config.Load()
	if err != nil || cfg.Models["anthropic"] != "claude-haiku-4-5" {
		t.Errorf("persisted model = %q (err %v), want claude-haiku-4-5", cfg.Models["anthropic"], err)
	}

	// esc closes without touching anything.
	m.command("/model")
	m = pressKeys(m, "o", "esc")
	if m.modelPick != nil {
		t.Fatal("picker open after esc")
	}
	if m.cfg.Model() != "claude-haiku-4-5" {
		t.Errorf("esc changed the model to %q", m.cfg.Model())
	}
}

// The with-arg form stays the direct-set power path: set, save, notice.
func TestModelDirectSetPersists(t *testing.T) {
	m := newSettingsModel(t)
	m.command("/model some-future-model")
	if m.cfg.Model() != "some-future-model" {
		t.Fatalf("model = %q, want some-future-model", m.cfg.Model())
	}
	if last := m.messages[len(m.messages)-1].raw; !strings.Contains(last, "model → test/some-future-model") {
		t.Errorf("notice = %q", last)
	}
	cfg, err := config.Load()
	if err != nil || cfg.Models["anthropic"] != "some-future-model" {
		t.Errorf("persisted model = %q (err %v), want some-future-model", cfg.Models["anthropic"], err)
	}
}

func TestModelPickFetch(t *testing.T) {
	m := newSettingsModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)

	// No cache: opening auto-fetches (the returned cmd runs the request
	// off the UI goroutine) and the dialog shows the fetch state.
	cmd := m.command("/model")
	if m.modelPick == nil || !m.modelPick.fetching || len(m.modelPick.all) != 0 {
		t.Fatalf("empty-cache open: picking=%+v", m.modelPick)
	}
	if cmd == nil {
		t.Fatal("empty-cache open scheduled no fetch")
	}
	if v := m.View().Content; !strings.Contains(v, "fetching models") {
		t.Errorf("fetching view missing status: %q", v)
	}

	// A result for another provider is stale and ignored.
	m.applyFetchedModels(modelsFetchedMsg{provider: "openai", models: []string{"gpt-5"}})
	if len(m.modelPick.all) != 0 || !m.modelPick.fetching {
		t.Fatalf("stale result applied: %+v", m.modelPick)
	}

	// The right result fills the list, lands the cursor on the active
	// model, and caches the choices for next time.
	m.applyFetchedModels(modelsFetchedMsg{provider: "anthropic", models: []string{
		"claude-sonnet-4-5", "claude-haiku-4-5",
	}})
	p := m.modelPick
	if p.fetching || len(p.all) != 2 || p.list[p.cursor] != "claude-sonnet-4-5" {
		t.Fatalf("applied fetch: fetching=%v all=%v cursor=%d", p.fetching, p.all, p.cursor)
	}
	cfg, err := config.Load()
	if err != nil || len(cfg.ModelChoices["anthropic"]) != 2 {
		t.Errorf("fetched choices not persisted: %v (err %v)", cfg.ModelChoices, err)
	}

	// f re-fetches on demand; f is fetch, not a filter character.
	if cmd := m.modelPickKey(keyMsg("f")); cmd == nil {
		t.Fatal("f did not schedule a fetch")
	} else if p := m.modelPick; !p.fetching || p.filter != "" {
		t.Fatalf("f state: fetching=%v filter=%q", p.fetching, p.filter)
	}

	// A failed refresh surfaces as a status note under the old list.
	fetchErr := errors.New("endpoint exploded")
	m.applyFetchedModels(modelsFetchedMsg{provider: "anthropic", err: fetchErr})
	p = m.modelPick
	if p.fetching || p.status == "" || len(p.all) != 2 {
		t.Fatalf("failed fetch: fetching=%v status=%q all=%v", p.fetching, p.status, p.all)
	}
	if v := m.View().Content; !strings.Contains(v, "fetch failed") {
		t.Errorf("view missing failure note: %q", v)
	}
}

func TestModelPickEmptyResultView(t *testing.T) {
	m := newSettingsModel(t)
	next, _ := m.Update(tea.WindowSizeMsg{Width: 100, Height: 30})
	m = next.(Model)
	cmd := m.command("/model")
	if cmd == nil {
		t.Fatal("empty-cache open scheduled no fetch")
	}
	m.applyFetchedModels(modelsFetchedMsg{provider: "anthropic"})
	if v := m.View().Content; !strings.Contains(v, "no models known") {
		t.Errorf("empty view missing hint: %q", v)
	}
}
