// Command mcpserver is a minimal MCP server used only by khode's client
// tests: it answers initialize, lists two tools, and serves them — echo
// returns the call arguments verbatim, showenv returns one environment
// variable so env pass-through is observable.
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
			result = map[string]any{"tools": []map[string]any{
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
			}}
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
		out.Flush()
	}
}
