// Package mcp implements a minimal Model Context Protocol client over
// stdio: it launches a server process, completes the initialize
// handshake, lists the tools the server advertises, and calls them.
// Messages are newline-delimited JSON-RPC 2.0. Only what khode needs is
// implemented — no resources, prompts, sampling, or transports beyond
// stdio.
package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// protocolVersion is the MCP spec version this client speaks. Servers
// reply with their own version; khode accepts whatever comes back.
const protocolVersion = "2024-11-05"

const (
	// InitTimeout bounds the initialize handshake; a server that cannot
	// introduce itself promptly is treated as broken.
	InitTimeout = 15 * time.Second
	// requestTimeout bounds one round-trip when the caller's context has
	// no deadline, so a hung server cannot freeze a turn forever.
	requestTimeout = 2 * time.Minute
	// maxLineBytes caps one framed message; tool results can be large.
	maxLineBytes = 4 << 20
	// maxListPages bounds tools/list pagination against a hostile server.
	maxListPages = 100
)

// Tool describes one tool a server advertises.
type Tool struct {
	Name        string
	Description string
	// InputSchema is the JSON-schema object describing the arguments;
	// servers that omit one get an empty object schema on the way out.
	InputSchema json.RawMessage
}

// Client is one running connection to an MCP server process. Calls are
// safe for concurrent use; the agent loop runs them sequentially.
type Client struct {
	cmd    *exec.Cmd
	stderr *limitedBuffer
	out    io.WriteCloser

	writeMu sync.Mutex
	mu      sync.Mutex
	nextID  int
	pending map[int]chan rpcMsg
	// notifyFn, when set, sees every notification the server sends.
	// Guarded by mu so it can be installed any time after Start.
	notifyFn func(method string)

	done     chan struct{} // closed when the reader sees EOF
	doneOnce sync.Once
}

// newConn builds a Client around an arbitrary message stream — exec
// pipes in production, in-memory pipes in tests — and starts the reader.
func newConn(r io.Reader, w io.WriteCloser) *Client {
	c := &Client{
		out:     w,
		pending: map[int]chan rpcMsg{},
		done:    make(chan struct{}),
	}
	go c.pump(r)
	return c
}

// Start launches an MCP server process and completes the initialize
// handshake. env entries are KEY=VALUE additions over the inherited
// environment. The returned Client must be Closed.
func Start(ctx context.Context, name, command string, args, env []string) (*Client, error) {
	cmd := exec.Command(command, args...)
	cmd.Env = append(os.Environ(), env...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderr := &limitedBuffer{max: 4 << 10}
	cmd.Stderr = stderr
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("starting mcp server %q: %w", name, err)
	}

	c := newConn(stdout, stdin)
	c.cmd, c.stderr = cmd, stderr

	initCtx := ctx
	if _, ok := initCtx.Deadline(); !ok {
		var cancel context.CancelFunc
		initCtx, cancel = context.WithTimeout(initCtx, InitTimeout)
		defer cancel()
	}
	if err := c.handshake(initCtx); err != nil {
		c.Close()
		return nil, fmt.Errorf("mcp server %q: %w", name, err)
	}
	return c, nil
}

// handshake runs the initialize round-trip and the initialized
// notification that marks the connection ready.
func (c *Client) handshake(ctx context.Context) error {
	var res initializeResult
	params := initializeParams{
		ProtocolVersion: protocolVersion,
		Capabilities:    map[string]any{},
		ClientInfo:      mcpInfo{Name: "khode", Version: "dev"},
	}
	if err := c.call(ctx, "initialize", params, &res); err != nil {
		return err
	}
	return c.notify("notifications/initialized", nil)
}

// Tools lists the server's tools, following pagination cursors.
func (c *Client) Tools(ctx context.Context) ([]Tool, error) {
	var out []Tool
	cursor := ""
	for page := 0; page < maxListPages; page++ {
		params := map[string]any{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		var res toolsPage
		if err := c.call(ctx, "tools/list", params, &res); err != nil {
			return nil, err
		}
		out = append(out, res.Tools...)
		if res.NextCursor == "" {
			return out, nil
		}
		cursor = res.NextCursor
	}
	return nil, errors.New("tools/list did not stop paginating")
}

// CallTool invokes a server tool and returns its concatenated text
// content and whether the server flagged the call as an error. Transport
// and protocol failures return a non-nil error.
func (c *Client) CallTool(ctx context.Context, name string, args json.RawMessage) (string, bool, error) {
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	var res callResult
	params := map[string]any{"name": name, "arguments": args}
	if err := c.call(ctx, "tools/call", params, &res); err != nil {
		return "", false, err
	}
	return joinContent(res.Content), res.IsError, nil
}

// Close shuts the connection down: the write side closes so the server
// can exit cleanly, and a real process is killed if it ignores that for
// two seconds. Pipe-backed test clients have no process to wait for.
func (c *Client) Close() error {
	c.writeMu.Lock()
	c.out.Close()
	c.writeMu.Unlock()

	if c.cmd != nil {
		waited := make(chan struct{})
		go func() { defer close(waited); c.cmd.Wait() }()
		select {
		case <-waited:
		case <-time.After(2 * time.Second):
			c.cmd.Process.Kill()
			<-waited
		}
	}
	c.failPending(errors.New("mcp server closed"))
	return nil
}

// SetNotify installs a hook the pump calls for every notification the
// server sends (e.g. notifications/tools/list_changed), in message
// order. It runs on the reader goroutine, so it must not block; the
// client drops the notification rather than stall the stream.
func (c *Client) SetNotify(fn func(method string)) {
	c.mu.Lock()
	c.notifyFn = fn
	c.mu.Unlock()
}

// Exited reports whether the server's output has closed: the process is
// gone, and every future call will fail with "mcp server exited".
func (c *Client) Exited() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

// --- JSON-RPC round trips ----------------------------------------------------

// call sends a request and decodes the result into out (may be nil).
func (c *Client) call(ctx context.Context, method string, params, out any) error {
	if _, ok := ctx.Deadline(); !ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, requestTimeout)
		defer cancel()
	}

	c.mu.Lock()
	c.nextID++
	id := c.nextID
	ch := make(chan rpcMsg, 1)
	c.pending[id] = ch
	c.mu.Unlock()

	if err := c.write(&rpcMsg{JSONRPC: "2.0", ID: idNumber(id), Method: method, Params: params}); err != nil {
		c.dropPending(id)
		return fmt.Errorf("sending %s: %w", method, err)
	}

	select {
	case msg := <-ch:
		if msg.Error != nil {
			return fmt.Errorf("%s: %s (code %d)", method, msg.Error.Message, msg.Error.Code)
		}
		if out != nil && len(msg.Result) > 0 {
			if err := json.Unmarshal(msg.Result, out); err != nil {
				return fmt.Errorf("decoding %s result: %w", method, err)
			}
		}
		return nil
	case <-ctx.Done():
		c.dropPending(id)
		return fmt.Errorf("%s: %w", method, ctx.Err())
	case <-c.done:
		c.dropPending(id)
		return fmt.Errorf("%s: mcp server exited: %s", method, c.stderrTail())
	}
}

// stderrTail reports the captured server stderr; pipe-backed test
// clients capture nothing.
func (c *Client) stderrTail() string {
	if c.stderr == nil {
		return "(no stderr)"
	}
	return c.stderr.String()
}

// notify sends a notification (no id, no reply expected).
func (c *Client) notify(method string, params any) error {
	return c.write(&rpcMsg{JSONRPC: "2.0", Method: method, Params: params})
}

// write frames one message as a newline-terminated JSON line.
func (c *Client) write(msg *rpcMsg) error {
	data, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.out.Write(append(data, '\n'))
	return err
}

// pump reads framed messages and routes them: responses to their pending
// call, server requests answered inline, notifications to the notify hook.
func (c *Client) pump(r io.Reader) {
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), maxLineBytes)
	for sc.Scan() {
		var msg rpcMsg
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			continue // not speakable JSON; skip rather than die
		}
		switch {
		case msg.ID != nil && msg.Method == "":
			c.resolve(*msg.ID, msg)
		case msg.ID != nil:
			c.answerServerRequest(*msg.ID, msg.Method)
		default:
			c.mu.Lock()
			fn := c.notifyFn
			c.mu.Unlock()
			if fn != nil {
				fn(msg.Method)
			}
		}
	}
	c.doneOnce.Do(func() { close(c.done) })
	c.failPending(fmt.Errorf("mcp server exited: %s", c.stderrTail()))
}

// resolve hands a response to the waiting call, if it is still pending.
func (c *Client) resolve(id int, msg rpcMsg) {
	c.mu.Lock()
	ch, ok := c.pending[id]
	delete(c.pending, id)
	c.mu.Unlock()
	if ok {
		ch <- msg
	}
}

func (c *Client) dropPending(id int) {
	c.mu.Lock()
	delete(c.pending, id)
	c.mu.Unlock()
}

func (c *Client) failPending(err error) {
	c.mu.Lock()
	chs := make([]chan rpcMsg, 0, len(c.pending))
	for id, ch := range c.pending {
		chs = append(chs, ch)
		delete(c.pending, id)
	}
	c.mu.Unlock()
	for _, ch := range chs {
		ch <- rpcMsg{Error: &rpcError{Code: -32000, Message: err.Error()}}
	}
}

// answerServerRequest replies to the two kinds of server-initiated
// requests khode understands: ping gets an empty result, everything else
// a method-not-found error so exotic servers fail loudly instead of
// hanging.
func (c *Client) answerServerRequest(id int, method string) {
	resp := &rpcMsg{JSONRPC: "2.0", ID: idNumber(id)}
	if method == "ping" {
		resp.Result = json.RawMessage("{}")
	} else {
		resp.Error = &rpcError{Code: -32601, Message: "method not supported: " + method}
	}
	c.write(resp)
}

// --- wire types ----------------------------------------------------------------

// rpcMsg is one JSON-RPC 2.0 message in either direction. ID is a
// pointer so notifications (absent id) are distinguishable from responses.
type rpcMsg struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *int            `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Params  any             `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

func idNumber(id int) *int { return &id }

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// initializeParams is the client's half of the initialize handshake.
type initializeParams struct {
	ProtocolVersion string  `json:"protocolVersion"`
	Capabilities    any     `json:"capabilities"`
	ClientInfo      mcpInfo `json:"clientInfo"`
}

type mcpInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type initializeResult struct {
	ProtocolVersion string  `json:"protocolVersion"`
	ServerInfo      mcpInfo `json:"serverInfo"`
}

type toolsPage struct {
	Tools      []Tool `json:"tools"`
	NextCursor string `json:"nextCursor"`
}

// callResult is a tools/call result: content blocks plus the isError flag.
type callResult struct {
	Content []contentBlock `json:"content"`
	IsError bool           `json:"isError"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// joinContent flattens a tools/call content list into model-readable
// text: text blocks verbatim, anything else as a [type] placeholder.
func joinContent(blocks []contentBlock) string {
	if len(blocks) == 0 {
		return ""
	}
	parts := make([]string, 0, len(blocks))
	for _, b := range blocks {
		if b.Type == "text" || b.Type == "" {
			parts = append(parts, b.Text)
			continue
		}
		parts = append(parts, "["+b.Type+"]")
	}
	return strings.Join(parts, "\n")
}

// limitedBuffer keeps the tail of a stream for error messages.
type limitedBuffer struct {
	max int
	mu  sync.Mutex
	buf []byte
}

func (b *limitedBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf = append(b.buf, p...)
	if len(b.buf) > b.max {
		b.buf = b.buf[len(b.buf)-b.max:]
	}
	return len(p), nil
}

// String returns the buffered tail, one line per input line.
func (b *limitedBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	s := strings.TrimSpace(string(b.buf))
	if s == "" {
		return "(no stderr)"
	}
	return s
}
