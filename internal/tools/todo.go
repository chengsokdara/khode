package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
)

// Todo statuses, as accepted in the tool input.
const (
	TodoPending    = "pending"
	TodoInProgress = "in_progress"
	TodoCompleted  = "completed"
)

// Todo is one task in the tracked list.
type Todo struct {
	Content string `json:"content"`
	Status  string `json:"status"`
}

// Todos is a stateful task-list tool: the model replaces the whole list
// on every call, which keeps its plan visible in the UI and stops
// multi-step work from drifting. State lives in memory for the app's
// lifetime and is classified read-only, so list updates work in every
// permission mode — they touch no project files.
type Todos struct {
	mu    sync.Mutex
	items []Todo
}

// NewTodos returns an empty task list.
func NewTodos() *Todos { return &Todos{} }

func (t *Todos) Name() string { return "todo" }

func (t *Todos) Description() string {
	return `Maintain your task list for the current work. Send the FULL list
every time: keep completed items (status "completed"), mark exactly the one
task you are working on "in_progress", and add new steps as you discover
them. Use it whenever work needs several steps or the user gives multiple
items. The list is shown to the user as live progress.`
}

func (t *Todos) Schema() json.RawMessage {
	return json.RawMessage(`{
  "type": "object",
  "required": ["items"],
  "properties": {
    "items": {
      "type": "array",
      "description": "The complete task list, in execution order.",
      "items": {
        "type": "object",
        "required": ["content", "status"],
        "properties": {
          "content": {"type": "string", "minLength": 1, "description": "Imperative task phrasing, e.g. 'add retry tests'."},
          "status": {"type": "string", "enum": ["pending", "in_progress", "completed"]}
        }
      }
    }
  }
}`)
}

// Exec replaces the list and returns its rendering so the model can
// confirm what is tracked. An empty list clears it.
func (t *Todos) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	var in struct {
		Items []Todo `json:"items"`
	}
	if err := arg(args, &in); err != nil {
		return "", err
	}
	for i, td := range in.Items {
		switch {
		case strings.TrimSpace(td.Content) == "":
			return "", fmt.Errorf("items[%d]: content is empty", i)
		case td.Status != TodoPending && td.Status != TodoInProgress && td.Status != TodoCompleted:
			return "", fmt.Errorf("items[%d]: status %q must be pending, in_progress, or completed", i, td.Status)
		}
	}

	t.mu.Lock()
	t.items = in.Items
	t.mu.Unlock()
	return t.render(), nil
}

// List snapshots the current tasks.
func (t *Todos) List() []Todo {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]Todo(nil), t.items...)
}

// render draws the list for both the model and the UI: in-progress first
// marker, then pending, then completed — the reading order of "what is
// happening now".
func (t *Todos) render() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	if len(t.items) == 0 {
		return "(task list cleared)"
	}
	mark := map[string]string{
		TodoInProgress: "❯",
		TodoPending:    "☐",
		TodoCompleted:  "☑",
	}
	order := map[string]int{TodoInProgress: 0, TodoPending: 1, TodoCompleted: 2}
	sorted := append([]Todo(nil), t.items...)
	for i := range sorted {
		for j := i + 1; j < len(sorted); j++ {
			if order[sorted[j].Status] < order[sorted[i].Status] {
				sorted[i], sorted[j] = sorted[j], sorted[i]
			}
		}
	}
	lines := make([]string, len(sorted))
	for i, td := range sorted {
		lines[i] = mark[td.Status] + " " + td.Content
	}
	return strings.Join(lines, "\n")
}
