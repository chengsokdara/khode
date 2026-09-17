package tools

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"khode/internal/mcp"
	"khode/internal/perm"
)

// fakeSource is an in-memory ToolSource for adapter tests.
type fakeSource struct {
	tools []mcp.Tool
	calls []mcpCall
	text  string
	isErr bool
	err   error
}

type mcpCall struct {
	name string
	args json.RawMessage
}

func (f *fakeSource) Tools(ctx context.Context) ([]mcp.Tool, error) { return f.tools, nil }

func (f *fakeSource) CallTool(ctx context.Context, name string, args json.RawMessage) (string, bool, error) {
	f.calls = append(f.calls, mcpCall{name: name, args: args})
	if f.err != nil {
		return "", false, f.err
	}
	return f.text, f.isErr, nil
}

func TestAddMCPRegistersNamespacedTools(t *testing.T) {
	src := &fakeSource{tools: []mcp.Tool{
		{Name: "search", Description: "search the docs", InputSchema: json.RawMessage(`{"type":"object","properties":{"q":{"type":"string"}}}`)},
		{Name: "fetch", Description: "fetch a page"},
	}}
	reg := NewRegistry()
	if err := AddMCP(reg, "docs", src, ""); err != nil {
		t.Fatal(err)
	}

	names := reg.Names()
	if len(names) != 2 || names[0] != "mcp__docs__fetch" || names[1] != "mcp__docs__search" {
		t.Fatalf("names = %v", names)
	}

	// Default risk is exec: an MCP tool can do anything, so it must be
	// gated like a shell command.
	if got := reg.RiskOf("mcp__docs__search"); got != perm.RiskExec {
		t.Fatalf("default risk = %v, want exec", got)
	}

	// Schema passes through, with the empty-object fallback when the
	// server omits one.
	tl, _ := reg.Get("mcp__docs__search")
	if string(tl.Schema()) != `{"type":"object","properties":{"q":{"type":"string"}}}` {
		t.Fatalf("schema = %s", tl.Schema())
	}
	tl, _ = reg.Get("mcp__docs__fetch")
	if string(tl.Schema()) != `{"type":"object"}` {
		t.Fatalf("fallback schema = %s", tl.Schema())
	}
}

func TestAddMCPRiskOverride(t *testing.T) {
	src := &fakeSource{tools: []mcp.Tool{{Name: "lookup"}}}
	reg := NewRegistry()
	if err := AddMCP(reg, "trusted", src, "read"); err != nil {
		t.Fatal(err)
	}
	if got := reg.RiskOf("mcp__trusted__lookup"); got != perm.RiskRead {
		t.Fatalf("read override → %v, want read", got)
	}

	// A bogus override degrades to exec, never to something permissive.
	reg2 := NewRegistry()
	if err := AddMCP(reg2, "shaky", src, "kindergarten"); err != nil {
		t.Fatal(err)
	}
	if got := reg2.RiskOf("mcp__shaky__lookup"); got != perm.RiskExec {
		t.Fatalf("bogus override → %v, want exec", got)
	}
}

func TestMCPToolExec(t *testing.T) {
	src := &fakeSource{tools: []mcp.Tool{{Name: "search"}}, text: "found it"}
	tool := &MCPTool{Source: src, Server: "docs", Tool: src.tools[0], risk: perm.RiskExec}

	out, err := tool.Exec(context.Background(), json.RawMessage(`{"q":"x"}`))
	if err != nil || out != "found it" {
		t.Fatalf("out=%q err=%v", out, err)
	}
	if len(src.calls) != 1 || src.calls[0].name != "search" {
		t.Fatalf("calls = %+v", src.calls)
	}

	// Server-side isError becomes a Go error carrying the message.
	src.isErr, src.text = true, "quota blown"
	if _, err := tool.Exec(context.Background(), nil); err == nil || err.Error() != "quota blown" {
		t.Fatalf("isError → err=%v", err)
	}

	// Transport failure is wrapped with the server name.
	src.isErr, src.err = false, errors.New("pipe broke")
	if _, err := tool.Exec(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "mcp docs") {
		t.Fatalf("transport err = %v", err)
	}

	src.isErr, src.err, src.text = false, nil, ""
	if out, err := tool.Exec(context.Background(), nil); err != nil || out != "(no content)" {
		t.Fatalf("empty result → out=%q err=%v", out, err)
	}
}
