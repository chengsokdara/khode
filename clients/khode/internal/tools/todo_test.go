package tools

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func todosExec(t *testing.T, items string) (string, error) {
	t.Helper()
	return (&Todos{}).Exec(context.Background(), json.RawMessage(items))
}

func TestTodosReplaceAndRender(t *testing.T) {
	td := &Todos{}
	out, err := td.Exec(context.Background(), json.RawMessage(`{"items":[
		{"content":"write the tool","status":"completed"},
		{"content":"add tests","status":"in_progress"},
		{"content":"update docs","status":"pending"}
	]}`))
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	// Reading order: in progress, pending, completed.
	want := "❯ add tests\n☐ update docs\n☑ write the tool"
	if out != want {
		t.Errorf("render = %q, want %q", out, want)
	}

	// A second call replaces the list rather than appending.
	if _, err := td.Exec(context.Background(), json.RawMessage(
		`{"items":[{"content":"only this","status":"pending"}]}`)); err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if got := td.List(); len(got) != 1 || got[0].Content != "only this" {
		t.Errorf("List after replace = %+v", got)
	}
}

func TestTodosClear(t *testing.T) {
	td := &Todos{}
	if _, err := td.Exec(context.Background(), json.RawMessage(
		`{"items":[{"content":"x","status":"pending"}]}`)); err != nil {
		t.Fatal(err)
	}
	out, err := td.Exec(context.Background(), json.RawMessage(`{"items":[]}`))
	if err != nil {
		t.Fatalf("Exec: %v", err)
	}
	if out != "(task list cleared)" || len(td.List()) != 0 {
		t.Errorf("clear: render=%q list=%+v", out, td.List())
	}
}

func TestTodosValidation(t *testing.T) {
	cases := map[string]string{
		"empty content":  `{"items":[{"content":"  ","status":"pending"}]}`,
		"bad status":     `{"items":[{"content":"x","status":"done"}]}`,
		"missing status": `{"items":[{"content":"x"}]}`,
		"not an object":  `[1,2]`,
	}
	for name, in := range cases {
		if _, err := todosExec(t, in); err == nil {
			t.Errorf("%s: Exec accepted %s", name, in)
		} else if !strings.Contains(err.Error(), "items[0]") && name != "not an object" {
			t.Errorf("%s: error lacks item index: %v", name, err)
		}
	}
}

func TestTodosRegisteredReadOnly(t *testing.T) {
	reg := Default(t.TempDir())
	td, ok := reg.Get("todo")
	if !ok {
		t.Fatal("todo tool not registered")
	}
	if reg.RiskOf("todo") != "read" {
		t.Errorf("todo risk = %q, want read (usable in every mode)", reg.RiskOf("todo"))
	}
	_ = td
}
