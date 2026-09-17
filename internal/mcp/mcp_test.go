package mcp

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"testing"
	"time"
)

// fakeServer speaks enough JSON-RPC server to drive a Client over
// in-memory pipes. handler produces the result (or error) for each
// request; notifications are dropped. Requests the handler receives are
// recorded.
type fakeServer struct {
	in       *io.PipeReader
	out      *io.PipeWriter
	requests []string // method names, in order

	t       *testing.T
	handler func(t *testing.T, method string, params json.RawMessage) (any, *rpcError)
}

func startFake(t *testing.T, handler func(t *testing.T, method string, params json.RawMessage) (any, *rpcError)) (*Client, *fakeServer) {
	t.Helper()
	// startFake owns the handshake, so it answers initialize itself and
	// delegates everything else to the test's handler.
	c, s := newFake(t, func(t *testing.T, method string, params json.RawMessage) (any, *rpcError) {
		if method == "initialize" {
			return initializeResult{ProtocolVersion: protocolVersion, ServerInfo: mcpInfo{Name: "fake", Version: "0"}}, nil
		}
		return handler(t, method, params)
	})
	if err := c.handshake(context.Background()); err != nil {
		t.Fatalf("handshake: %v", err)
	}
	return c, s
}

// newFake builds a Client over in-memory pipes with the given handler on
// the server side; the handshake is left to the caller.
func newFake(t *testing.T, handler func(t *testing.T, method string, params json.RawMessage) (any, *rpcError)) (*Client, *fakeServer) {
	t.Helper()
	toSrvR, toSrvW := io.Pipe() // client → server
	toCliR, toCliW := io.Pipe() // server → client
	s := &fakeServer{in: toSrvR, out: toCliW, t: t, handler: handler}
	c := newConn(toCliR, toSrvW)
	// The pipes are unbuffered, so the server must be reading before
	// anything writes its first request.
	go s.serve()
	t.Cleanup(func() { c.Close() })
	return c, s
}

// serve reads requests until the pipe closes; it runs on its own
// goroutine and answers ping itself (as the client-facing spec requires).
func (s *fakeServer) serve() {
	sc := bufio.NewScanner(s.in)
	for sc.Scan() {
		var msg rpcMsg
		if err := json.Unmarshal(sc.Bytes(), &msg); err != nil {
			continue
		}
		if msg.Method == "" {
			continue // a response to a server-initiated request; none sent
		}
		s.requests = append(s.requests, msg.Method)
		if msg.ID == nil {
			continue // notification
		}
		var result any
		var rpcErr *rpcError
		if msg.Method == "ping" {
			result = json.RawMessage("{}")
		} else {
			params, _ := json.Marshal(msg.Params) // decoded as any; re-encode for handlers
			result, rpcErr = s.handler(s.t, msg.Method, params)
		}
		resp := rpcMsg{JSONRPC: "2.0", ID: msg.ID}
		if rpcErr != nil {
			resp.Error = rpcErr
		} else {
			data, _ := json.Marshal(result)
			resp.Result = data
		}
		data, _ := json.Marshal(resp)
		s.out.Write(append(data, '\n'))
	}
}

func okHandler(t *testing.T, wantMethods map[string]func(t *testing.T, params json.RawMessage) any) func(*testing.T, string, json.RawMessage) (any, *rpcError) {
	return func(t *testing.T, method string, params json.RawMessage) (any, *rpcError) {
		h, ok := wantMethods[method]
		if !ok {
			return nil, &rpcError{Code: -32601, Message: "unexpected method " + method}
		}
		return h(t, params), nil
	}
}

func TestHandshakeSendsInitialize(t *testing.T) {
	var sawProtocol string
	c, s := newFake(t, okHandler(t, map[string]func(*testing.T, json.RawMessage) any{
		"initialize": func(t *testing.T, params json.RawMessage) any {
			var p initializeParams
			if err := json.Unmarshal(params, &p); err != nil {
				t.Fatalf("decoding initialize params: %v", err)
			}
			sawProtocol = p.ProtocolVersion
			return initializeResult{ProtocolVersion: "2024-11-05", ServerInfo: mcpInfo{Name: "fake", Version: "1"}}
		},
	}))
	if err := c.handshake(context.Background()); err != nil {
		t.Fatalf("handshake: %v", err)
	}

	if sawProtocol != protocolVersion {
		t.Fatalf("client offered protocol %q, want %q", sawProtocol, protocolVersion)
	}
	// The connection is usable after the handshake.
	if len(s.requests) != 1 || s.requests[0] != "initialize" {
		t.Fatalf("requests = %v, want exactly one initialize", s.requests)
	}
}

func TestToolsListPagination(t *testing.T) {
	c, _ := startFake(t, func(t *testing.T, method string, params json.RawMessage) (any, *rpcError) {
		if method != "tools/list" {
			return nil, &rpcError{Code: -32601, Message: method}
		}
		var p struct {
			Cursor string `json:"cursor"`
		}
		json.Unmarshal(params, &p)
		if p.Cursor == "" {
			return toolsPage{Tools: []Tool{
				{Name: "a", Description: "first page"},
				{Name: "b"},
			}, NextCursor: "page2"}, nil
		}
		if p.Cursor != "page2" {
			t.Fatalf("unexpected cursor %q", p.Cursor)
		}
		return toolsPage{Tools: []Tool{{Name: "c"}}}, nil
	})

	tools, err := c.Tools(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if len(tools) != 3 || tools[0].Name != "a" || tools[2].Name != "c" {
		t.Fatalf("got %d tools across pages: %+v", len(tools), tools)
	}
}

func TestCallToolJoinsContent(t *testing.T) {
	var sawArgs json.RawMessage
	c, _ := startFake(t, okHandler(t, map[string]func(*testing.T, json.RawMessage) any{
		"tools/call": func(t *testing.T, params json.RawMessage) any {
			var p struct {
				Name      string          `json:"name"`
				Arguments json.RawMessage `json:"arguments"`
			}
			json.Unmarshal(params, &p)
			sawArgs = p.Arguments
			return callResult{Content: []contentBlock{
				{Type: "text", Text: "hello"},
				{Type: "image"},
				{Type: "text", Text: "world"},
			}}
		},
	}))

	text, isErr, err := c.CallTool(context.Background(), "mix", nil)
	if err != nil || isErr {
		t.Fatalf("err=%v isErr=%v", err, isErr)
	}
	if text != "hello\n[image]\nworld" {
		t.Fatalf("text = %q", text)
	}
	if string(sawArgs) != "{}" {
		t.Fatalf("nil args were not defaulted to {{}}: %s", sawArgs)
	}
}

func TestCallToolServerError(t *testing.T) {
	c, _ := startFake(t, okHandler(t, map[string]func(*testing.T, json.RawMessage) any{
		"tools/call": func(t *testing.T, params json.RawMessage) any {
			return callResult{
				Content: []contentBlock{{Type: "text", Text: "disk on fire"}},
				IsError: true,
			}
		},
	}))

	text, isErr, err := c.CallTool(context.Background(), "boom", json.RawMessage(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	if !isErr || text != "disk on fire" {
		t.Fatalf("isErr=%v text=%q, want error flag with the server's message", isErr, text)
	}
}

func TestServerRequestsAnswered(t *testing.T) {
	toCliR, toCliW := io.Pipe() // server → client
	toSrvR, toSrvW := io.Pipe() // client → server
	c := newConn(toCliR, toSrvW)
	t.Cleanup(func() { toCliW.Close(); toSrvW.Close() })

	// One reader owns toSrvR so no bytes are lost between replies.
	br := bufio.NewReader(toSrvR)
	readReply := func() rpcMsg {
		ch := make(chan []byte, 1)
		go func() {
			line, err := br.ReadBytes('\n')
			if err != nil {
				close(ch)
				return
			}
			ch <- line
		}()
		select {
		case line := <-ch:
			var m rpcMsg
			if err := json.Unmarshal(line, &m); err != nil {
				t.Fatalf("client reply is not JSON: %v", err)
			}
			return m
		case <-time.After(2 * time.Second):
			t.Fatal("no reply to a server request in time")
			return rpcMsg{}
		}
	}
	sendServerRequest := func(method string, id int) {
		req, _ := json.Marshal(rpcMsg{JSONRPC: "2.0", ID: idNumber(id), Method: method})
		if _, err := toCliW.Write(append(req, '\n')); err != nil {
			t.Fatal(err)
		}
	}

	// ping must be answered with an empty result…
	sendServerRequest("ping", 42)
	if reply := readReply(); reply.Result == nil || string(reply.Result) != "{}" {
		t.Fatalf("ping reply = %s, want empty result {}", reply.Result)
	}
	// …and unsupported methods with -32601, so exotic servers fail
	// loudly instead of hanging on a reply that never comes.
	sendServerRequest("sampling/createMessage", 43)
	if reply := readReply(); reply.Error == nil || reply.Error.Code != -32601 {
		t.Fatalf("unsupported-method reply = %+v, want code -32601", reply.Error)
	}
	_ = c
}

func TestServerExitFailsPendingCall(t *testing.T) {
	toCliR, toCliW := io.Pipe()
	_, toSrvW := io.Pipe() // its reader is never served; writes fail once closed
	c := newConn(toCliR, toSrvW)
	t.Cleanup(func() { toCliW.Close(); toSrvW.Close() })

	// Close both server ends: the pump sees EOF and the pending
	// tools/list must fail instead of hanging.
	toCliW.Close()
	toSrvW.Close()

	done := make(chan error, 1)
	go func() {
		_, err := c.Tools(context.Background())
		done <- err
	}()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("Tools succeeded after the server exited")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Tools hung after the server exited")
	}
}
