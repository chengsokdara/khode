package mcp

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// serverBin is the compiled testdata/mcpserver helper, built once per
// test-binary run so the subprocess path (pipes, env) is covered for
// real, not just the in-memory pipe fakes.
var serverBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "khode-mcp-test")
	if err != nil {
		fmt.Fprintf(os.Stderr, "temp dir: %v\n", err)
		os.Exit(1)
	}
	serverBin = filepath.Join(dir, "mcpserver")
	build := exec.Command("go", "build", "-o", serverBin, "./testdata/mcpserver")
	if out, err := build.CombinedOutput(); err != nil {
		fmt.Fprintf(os.Stderr, "building test mcp server: %v\n%s", err, out)
		os.Exit(1)
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

func TestRealServerEndToEnd(t *testing.T) {
	ctx := context.Background()

	c, err := Start(ctx, "echo-server", serverBin, nil, []string{"KHOKE_TEST_VAR=passed-through"})
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	t.Cleanup(func() { c.Close() })

	tools, err := c.Tools(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 2 || tools[0].Name != "echo" || tools[1].Name != "showenv" {
		t.Fatalf("tools = %+v", tools)
	}

	text, isErr, err := c.CallTool(ctx, "echo", json.RawMessage(`{"hi":true}`))
	if err != nil || isErr || text != `{"hi":true}` {
		t.Fatalf("echo: text=%q isErr=%v err=%v", text, isErr, err)
	}

	// The env addition must reach the server process.
	text, isErr, err = c.CallTool(ctx, "showenv", nil)
	if err != nil || isErr || text != "passed-through" {
		t.Fatalf("showenv: text=%q isErr=%v err=%v", text, isErr, err)
	}
}

func TestStartFailsOnBadCommand(t *testing.T) {
	if _, err := Start(context.Background(), "nope", "./definitely-not-a-binary-9x7", nil, nil); err == nil {
		t.Fatal("Start succeeded for a nonexistent command")
	}
}
