#!/usr/bin/env python3
"""Scripted OpenAI-protocol server. Requests are routed by body:
"# Context gatherer" (the UI's first-prompt sweep) gets a brief after a
hold, "# Subagent" (a task subagent) gets a grep call on its first
request and a report on its second, and everything else is the outer
conversation: rounds replay write → edit → answer, then a task(explore)
call, then a two-child task fan-out, then the closing answer. The holds
keep the live "gathering context" / subagent activity lines readable in
the captured frames. Threaded so parallel children are served truly
concurrently."""
import json
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

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
    outer = 0
    fanout_sent = False
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
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()

        if b"# Context gatherer" in body:
            # The first-prompt sweep: one round, brief only, held so the
            # "gathering context" block is on screen in captures.
            time.sleep(1.5)
            sse(self, [
                chunk({"content": "Summary: a small Go repo with one sample file (hello.txt)."}),
                chunk({}, finish="stop"),
                chunk({}, usage={"prompt_tokens": 800, "completion_tokens": 40}),
            ])
            return

        if b"# Subagent" in body:
            # A task subagent: first request gets a grep call, the
            # second (its transcript now carries a tool result) gets the
            # final report, held so the live activity line is readable.
            if b'"role":"tool"' in body:
                time.sleep(3.0)  # keep the live activity line readable
                sse(self, [
                    chunk({"content": "Report: one Go package lives in cmd/khode; hello.txt holds the sample file."}),
                    chunk({}, finish="stop"),
                    chunk({}, usage={"prompt_tokens": 1100, "completion_tokens": 40}),
                ])
            else:
                ga = json.dumps({"pattern": "package "})
                sse(self, [
                    chunk({"role": "assistant"}),
                    chunk({"tool_calls": [{"index": 0, "id": "call_sub1", "type": "function",
                                           "function": {"name": "grep", "arguments": ga}}]}),
                    chunk({}, finish="tool_calls"),
                    chunk({}, usage={"prompt_tokens": 900, "completion_tokens": 30}),
                ])
            return

        if b"# MCP refresh" in body:
            # The MCP live-refresh scenario: the request without the
            # echo call in its transcript calls the selftest server's
            # echo tool (the server flips its tool set right after
            # answering and pushes tools/list_changed); once call_mcp1
            # has a result, the turn closes while khode re-lists in the
            # background. Later turns still carrying the prompt also
            # land here and just answer — the notification fired once.
            if b'"call_mcp1"' in body:
                sse(self, [
                    chunk({"content": "Echoed through the MCP tool; the server's tool list changed underneath us."}),
                    chunk({}, finish="stop"),
                    chunk({}, usage={"prompt_tokens": 5000, "completion_tokens": 20}),
                ])
            else:
                ea = json.dumps({"text": "ping"})
                sse(self, [
                    chunk({"role": "assistant"}),
                    chunk({"content": "Calling the MCP echo tool."}),
                    chunk({"tool_calls": [{"index": 0, "id": "call_mcp1", "type": "function",
                                           "function": {"name": "mcp__selftest__echo", "arguments": ea}}]}),
                    chunk({}, finish="tool_calls"),
                    chunk({}, usage={"prompt_tokens": 4600, "completion_tokens": 30}),
                ])
            return

        H.outer += 1
        if H.outer == 4:
            ta = json.dumps({"prompt": "survey this repository",
                             "subagent_type": "explore",
                             "description": "survey the repo"})
            sse(self, [
                chunk({"role": "assistant"}),
                chunk({"content": "Delegating the survey."}),
                chunk({"tool_calls": [{"index": 0, "id": "call_4", "type": "function",
                                       "function": {"name": "task", "arguments": ta}}]}),
                chunk({}, finish="tool_calls"),
                chunk({}, usage={"prompt_tokens": 4200, "completion_tokens": 50}),
            ])
        elif H.outer >= 5:
            # A read-only fan-out, fired once by the prompt that asks for
            # it: TWO task(explore) calls in one round, so khode runs
            # them side by side and each task call line carries its own
            # live activity. The turn's continuation (the same prompt in
            # history, plus the tool results) gets the closing answer.
            if b"fan out" in body and not H.fanout_sent:
                H.fanout_sent = True
                ta1 = json.dumps({"prompt": "map the go packages",
                                  "subagent_type": "explore",
                                  "description": "map packages"})
                ta2 = json.dumps({"prompt": "describe the sample file",
                                  "subagent_type": "explore",
                                  "description": "describe sample"})
                sse(self, [
                    chunk({"role": "assistant"}),
                    chunk({"content": "Fanning out two explorers."}),
                    chunk({"tool_calls": [
                        {"index": 0, "id": "call_5a", "type": "function",
                         "function": {"name": "task", "arguments": ta1}},
                        {"index": 1, "id": "call_5b", "type": "function",
                         "function": {"name": "task", "arguments": ta2}},
                    ]}),
                    chunk({}, finish="tool_calls"),
                    chunk({}, usage={"prompt_tokens": 4400, "completion_tokens": 50}),
                ])
            else:
                sse(self, [
                    chunk({"content": "Both explore agents report: one Go package in cmd/khode, sample file on disk."}),
                    chunk({}, finish="stop"),
                    chunk({}, usage={"prompt_tokens": 4800, "completion_tokens": 60}),
                ])
        elif H.outer == 2:
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
        elif H.outer == 3:
            sse(self, [
                chunk({"content": "Edited and verified."}),
                chunk({}, finish="stop"),
                chunk({}, usage={"prompt_tokens": 3600, "completion_tokens": 20}),
            ])
        elif H.outer == 1:
            time.sleep(3.0)  # keep the fresh context brief readable
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

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
