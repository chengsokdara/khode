// Command mcpserver is a minimal MCP server used only by khode's client
// tests: it answers initialize, lists two tools, and serves them — echo
// returns the call arguments verbatim, showenv returns one environment
// variable so env pass-through is observable. With KHOKE_MCP_MUTATE=1,
// the first tools/call flips the advertised set (showenv out, flip in)
// and pushes notifications/tools/list_changed, so the tmux selftest can
// watch khode re-list live.
package main

import (
	"bufio"
	"encoding/json"
	"os"
)

func main() {
	in := bufio.NewScanner(os.Stdin)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	mutate := os.Getenv("KHOKE_MCP_MUTATE") == "1"
	mutated := false
	base := []map[string]any{
		{
			"name":        "echo",
			"description": "return the call arguments verbatim",
			"inputSchema": map[string]any{"type": "object"},
		},
		{
			"name":        "showenv",
			"description": "return KHOKE_TEST_VAR",
			"inputSchema": map[string]any{"type": "object"},
		},
	}
	flipped := []map[string]any{
		base[0],
		{
			"name":        "flip",
			"description": "appear after the tool list changed",
			"inputSchema": map[string]any{"type": "object"},
		},
	}

	for in.Scan() {
		var msg struct {
			ID     *int            `json:"id"`
			Method string          `json:"method"`
			Params json.RawMessage `json:"params"`
		}
		if json.Unmarshal(in.Bytes(), &msg) != nil || msg.Method == "" {
			continue
		}
		if msg.ID == nil {
			continue // notification: nothing to answer
		}

		var result any
		switch msg.Method {
		case "initialize":
			result = map[string]any{
				"protocolVersion": "2024-11-05",
				"serverInfo":      map[string]any{"name": "mcpserver", "version": "0"},
			}
		case "tools/list":
			list := base
			if mutated {
				list = flipped
			}
			result = map[string]any{"tools": list}
		case "tools/call":
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			json.Unmarshal(msg.Params, &p)
			text := ""
			switch p.Name {
			case "echo":
				if len(p.Arguments) == 0 {
					text = "{}"
				} else {
					text = string(p.Arguments)
				}
			case "showenv":
				text = os.Getenv("KHOKE_TEST_VAR")
			case "flip":
				text = "flipped"
			}
			result = map[string]any{
				"content": []map[string]any{{"type": "text", "text": text}},
			}
		case "ping":
			result = map[string]any{}
		default:
			continue
		}

		resp, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": msg.ID, "result": result})
		out.Write(append(resp, '\n'))
		if msg.Method == "tools/call" && mutate && !mutated {
			mutated = true
			note, _ := json.Marshal(map[string]any{"jsonrpc": "2.0", "method": "notifications/tools/list_changed"})
			out.Write(append(note, '\n'))
		}
		out.Flush()
	}
}
