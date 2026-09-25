#!/usr/bin/env python3
"""Scripted OpenAI-protocol server: round 1 streams thinking + prose +
a write tool call (26-line file), round 2 streams the closing answer."""
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

PORT = 19731
FILE_LINES = [f"line {i}: hello from the fake model" for i in range(1, 26)] + ["", "trailing after a blank"]

def chunk(delta, finish=None, usage=None):
    d = {"id": "chatcmpl-x", "object": "chat.completion.chunk",
         "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
    if usage:
        d["usage"] = usage
    return d

def sse(self, chunks):
    for c in chunks:
        self.wfile.write(b"data: " + json.dumps(c).encode() + b"\n\n")
    self.wfile.write(b"data: [DONE]\n\n")

class H(BaseHTTPRequestHandler):
    count = 0
    def log_message(self, *a):
        pass
    def do_GET(self):
        if self.path.endswith("/models"):
            body = json.dumps({"data": [{"id": "test-model"}]}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()
    def do_POST(self):
        self.rfile.read(int(self.headers.get("Content-Length", 0)))
        H.count += 1
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        if H.count == 2:
            ea = json.dumps({"path": "hello.txt",
                             "old_string": "line 5: hello from the fake model",
                             "new_string": "line 5: EDITED by the fake model"})
            sse(self, [
                chunk({"role": "assistant"}),
                chunk({"reasoning_content": "now I will edit line 5 so the diff shows both bands"}),
                chunk({"content": "Editing line 5."}),
                chunk({"tool_calls": [{"index": 0, "id": "call_2", "type": "function",
                                       "function": {"name": "edit", "arguments": ea}}]}),
                chunk({}, finish="tool_calls"),
                chunk({}, usage={"prompt_tokens": 3000, "completion_tokens": 80}),
            ])
        elif H.count == 3:
            sse(self, [
                chunk({"content": "Edited and verified."}),
                chunk({}, finish="stop"),
                chunk({}, usage={"prompt_tokens": 3600, "completion_tokens": 20}),
            ])
        elif H.count == 1:
            full_args = json.dumps({"path": "hello.txt", "content": "\n".join(FILE_LINES) + "\n"})
            third = len(full_args) // 3
            args1, args2, args3 = full_args[:third], full_args[third:2*third], full_args[2*third:]
            sse(self, [
                chunk({"role": "assistant"}),
                chunk({"reasoning_content": "the user wants a file; I will write one with 26 lines so the diff caps"}),
                chunk({"content": "Creating hello.txt now."}),
                chunk({"tool_calls": [{"index": 0, "id": "call_1", "type": "function",
                                       "function": {"name": "write", "arguments": args1}}]}),
                chunk({"tool_calls": [{"index": 0, "function": {"arguments": args2}}]}),
                chunk({"tool_calls": [{"index": 0, "function": {"arguments": args3}}]}),
                chunk({}, finish="tool_calls"),
                chunk({}, usage={"prompt_tokens": 1200, "completion_tokens": 300}),
            ])
        else:
            sse(self, [
                chunk({"content": "Done - hello.txt is on disk."}),
                chunk({}, finish="stop"),
                chunk({}, usage={"prompt_tokens": 2400, "completion_tokens": 60}),
            ])

HTTPServer(("127.0.0.1", PORT), H).serve_forever()
