package hooks

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"khode/internal/config"
)

func TestPreToolBlocksOnExitTwo(t *testing.T) {
	dir := t.TempDir()
	r := New(config.Hooks{PreTool: []config.Hook{
		{Command: `echo "not allowed" >&2; exit 2`},
	}}, dir)

	err := r.PreTool(context.Background(), "bash", json.RawMessage(`{"command":"rm -rf /"}`))
	var be *BlockError
	if !errors.As(err, &be) {
		t.Fatalf("err = %v, want BlockError", err)
	}
	if be.Reason != "not allowed" {
		t.Fatalf("reason = %q", be.Reason)
	}
}

func TestPreToolBlockWithoutStderrUsesCommand(t *testing.T) {
	r := New(config.Hooks{PreTool: []config.Hook{{Command: `exit 2`}}}, t.TempDir())
	err := r.PreTool(context.Background(), "bash", nil)
	var be *BlockError
	if !errors.As(err, &be) || be.Reason == "" {
		t.Fatalf("err = %v, want a BlockError with a default reason", err)
	}
}

func TestPreToolNonZeroExitDoesNotBlock(t *testing.T) {
	r := New(config.Hooks{PreTool: []config.Hook{
		{Command: `echo warning >&2; exit 1`},
	}}, t.TempDir())
	if err := r.PreTool(context.Background(), "bash", nil); err != nil {
		t.Fatalf("exit 1 blocked the call: %v", err)
	}
}

func TestHookToolFilter(t *testing.T) {
	dir := t.TempDir()
	marker := filepath.Join(dir, "ran")
	r := New(config.Hooks{PreTool: []config.Hook{
		{Command: "touch " + marker, Tools: []string{"write"}},
	}}, dir)

	if err := r.PreTool(context.Background(), "bash", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("hook ran for a tool it was not scoped to")
	}
	if err := r.PreTool(context.Background(), "write", nil); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("hook did not run for its scoped tool: %v", err)
	}
}

func TestHookReceivesPayloadOnStdin(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "payload.json")
	r := New(config.Hooks{PreTool: []config.Hook{
		{Command: "cat > " + capture},
	}}, dir)

	if err := r.PreTool(context.Background(), "grep", json.RawMessage(`{"pattern":"x"}`)); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatalf("hook wrote no payload: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("payload is not JSON: %v", err)
	}
	if got["event"] != "pre_tool" || got["tool"] != "grep" {
		t.Fatalf("payload = %v", got)
	}
	if !reflect.DeepEqual(got["args"], map[string]any{"pattern": "x"}) {
		t.Fatalf("args = %v", got["args"])
	}
}

func TestPostToolCarriesOutputAndError(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "payload.json")
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: "cat > " + capture + " ; exit 2"}, // exit 2 with no output stays silent
	}}, dir)

	fb := r.PostTool(context.Background(), "bash", nil, "some output", errors.New("boom"))
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatalf("post hook did not run: %v", err)
	}
	var got map[string]any
	json.Unmarshal(data, &got)
	if got["event"] != "post_tool" || got["output"] != "some output" || got["error"] != "boom" {
		t.Fatalf("payload = %v", got)
	}
	if fb != "" {
		t.Fatalf("feedback = %q, want none from an exit 2 with no message", fb)
	}
}

func TestPostToolStdoutFeedsBack(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo "file formatted"`},
	}}, t.TempDir())
	if fb := r.PostTool(context.Background(), "edit", nil, "done", nil); fb != "file formatted" {
		t.Fatalf("feedback = %q", fb)
	}
}

func TestPostToolExitTwoFlagsWithStderr(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo "not gofmt-clean" >&2; exit 2`},
	}}, t.TempDir())
	if fb := r.PostTool(context.Background(), "write", nil, "done", nil); fb != "not gofmt-clean" {
		t.Fatalf("feedback = %q", fb)
	}
}

func TestPostToolExitTwoWithoutStderrFallsBackToStdout(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo flagged; exit 2`},
	}}, t.TempDir())
	if fb := r.PostTool(context.Background(), "write", nil, "", nil); fb != "flagged" {
		t.Fatalf("feedback = %q", fb)
	}
}

func TestPostToolOtherExitsStaySilent(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo noise; exit 1`},
	}}, t.TempDir())
	if fb := r.PostTool(context.Background(), "bash", nil, "out", nil); fb != "" {
		t.Fatalf("feedback = %q, want none", fb)
	}
}

func TestPostToolJoinsAllHooks(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo first`},
		{Command: `echo noise >&2; exit 1`}, // silent failure must not stop the list
		{Command: `echo second`},
	}}, t.TempDir())
	if fb := r.PostTool(context.Background(), "read", nil, "", nil); fb != "first\n\nsecond" {
		t.Fatalf("feedback = %q", fb)
	}
}

func TestPostToolFeedbackCapped(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `head -c 20000 /dev/zero | tr '\0' 'x'`},
	}}, t.TempDir())
	fb := r.PostTool(context.Background(), "read", nil, "", nil)
	if len(fb) > maxHookFeedback {
		t.Fatalf("feedback is %d bytes, cap is %d", len(fb), maxHookFeedback)
	}
	if !strings.HasSuffix(fb, "(…truncated)") {
		t.Fatalf("feedback lacks the truncation marker: …%q", fb[len(fb)-40:])
	}
}

func TestPostToolCanceledContextYieldsNoFeedback(t *testing.T) {
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: `echo seen`},
	}}, t.TempDir())
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if fb := r.PostTool(ctx, "bash", nil, "", nil); fb != "" {
		t.Fatalf("feedback = %q, want none on a canceled context", fb)
	}
}

func TestHookMalformedArgsRideAsEmptyObject(t *testing.T) {
	dir := t.TempDir()
	capture := filepath.Join(dir, "payload.json")
	r := New(config.Hooks{PostTool: []config.Hook{
		{Command: "cat > " + capture + `; echo flagged >&2; exit 2`},
	}}, dir)

	// execCall runs the model's raw bytes, so args can be invalid JSON —
	// the hook must still fire and its exit-2 message still feed back.
	if fb := r.PostTool(context.Background(), "bash", json.RawMessage(`bad`), "", nil); fb != "flagged" {
		t.Fatalf("feedback = %q, want the exit-2 message", fb)
	}
	var got map[string]any
	data, err := os.ReadFile(capture)
	if err != nil {
		t.Fatalf("hook did not run on malformed args: %v", err)
	}
	json.Unmarshal(data, &got)
	if !reflect.DeepEqual(got["args"], map[string]any{}) {
		t.Fatalf("args = %v, want {}", got["args"])
	}
}

func TestHookTimeoutDoesNotBlock(t *testing.T) {
	r := New(config.Hooks{PreTool: []config.Hook{
		{Command: `sleep 30; exit 2`},
	}}, t.TempDir())
	r.Timeout = 100 * time.Millisecond

	start := time.Now()
	if err := r.PreTool(context.Background(), "bash", nil); err != nil {
		t.Fatalf("timed-out hook blocked the call: %v", err)
	}
	if time.Since(start) > 5*time.Second {
		t.Fatal("hook timeout was not applied")
	}
}

func TestEnabled(t *testing.T) {
	if New(config.Hooks{}, t.TempDir()).Enabled() {
		t.Fatal("no hooks configured but Enabled")
	}
	if !New(config.Hooks{PostTool: []config.Hook{{Command: "true"}}}, t.TempDir()).Enabled() {
		t.Fatal("hooks configured but not Enabled")
	}
}
