package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"khode/internal/mcp"
	"khode/internal/perm"
)

// MCP bridge: every tool an MCP server advertises becomes a registry
// entry named mcp__<server>__<tool>, so provider tool lists and the
// agent loop need no special cases for remote tools.

// ToolSource is the slice of an MCP connection the adapter needs;
// *mcp.Client satisfies it and tests can fake a server instead.
type ToolSource interface {
	Tools(ctx context.Context) ([]mcp.Tool, error)
	CallTool(ctx context.Context, name string, args json.RawMessage) (string, bool, error)
}

// MCPTool is one tool served by an MCP server.
type MCPTool struct {
	Source ToolSource
	Server string // config name of the server, for namespacing and errors
	Tool   mcp.Tool
	// risk is the permission class of every tool on this server.
	risk perm.Risk
}

func (t *MCPTool) Name() string        { return "mcp__" + t.Server + "__" + t.Tool.Name }
func (t *MCPTool) Description() string { return t.Tool.Description }

func (t *MCPTool) Schema() json.RawMessage {
	if len(t.Tool.InputSchema) > 0 {
		return t.Tool.InputSchema
	}
	return json.RawMessage(`{"type":"object"}`)
}

func (t *MCPTool) Risk() perm.Risk { return t.risk }

// Exec forwards the call to the server. A server-side isError comes back
// as a Go error carrying the server's message, so the model sees it as a
// failed call just like a local tool failure.
func (t *MCPTool) Exec(ctx context.Context, args json.RawMessage) (string, error) {
	text, isErr, err := t.Source.CallTool(ctx, t.Tool.Name, args)
	if err != nil {
		return "", fmt.Errorf("mcp %s: %w", t.Server, err)
	}
	if isErr {
		if text == "" {
			text = "(server reported an error without a message)"
		}
		return "", fmt.Errorf("%s", text)
	}
	if text == "" {
		return "(no content)", nil
	}
	return text, nil
}

// AddMCP lists the tools a server advertises and registers each one.
// riskOverride is the config's per-server risk ("read", "write", "exec");
// empty or unknown values degrade to exec, because an MCP tool can do
// anything and must never be silently auto-approved.
func AddMCP(r *Registry, server string, src ToolSource, riskOverride string) error {
	list, err := src.Tools(context.Background())
	if err != nil {
		return err
	}
	for _, tl := range list {
		r.Register(&MCPTool{Source: src, Server: server, Tool: tl, risk: parseRisk(riskOverride)})
	}
	return nil
}

// RemoveMCP drops every tool of one MCP server (mcp__<server>__*),
// undoing AddMCP when a server is deleted from the settings UI. Their
// session disable-toggles go with them, so re-adding the server starts
// with everything enabled. A server with no registered tools is not an
// error.
func RemoveMCP(r *Registry, server string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	prefix := "mcp__" + server + "__"
	for name := range r.byName {
		if strings.HasPrefix(name, prefix) {
			delete(r.byName, name)
			delete(r.disabled, name)
		}
	}
}

// parseRisk maps a config risk string to perm.Risk; MCP defaults to exec.
func parseRisk(s string) perm.Risk {
	switch perm.Risk(strings.ToLower(strings.TrimSpace(s))) {
	case perm.RiskRead:
		return perm.RiskRead
	case perm.RiskWrite:
		return perm.RiskWrite
	default:
		return perm.RiskExec
	}
}

// interface guards for the MCP adapter.
var (
	_ Tool           = (*MCPTool)(nil)
	_ RiskClassifier = (*MCPTool)(nil)
)
