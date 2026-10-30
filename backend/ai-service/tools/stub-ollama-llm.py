"""Ollama 压测桩（仅供本机自测，禁止指向生产）。

模拟 /api/generate 的两种模式：
- 非流式：等待 --latency 毫秒后返回完整 `{response: <JSON 字符串>}`。
- 流式（Ollama NDJSON）：先等 --first-token 毫秒吐出首个分片，再在剩余时间内陆续吐出其余分片。

同时实现 /api/tags，使 ai-service 的就绪探针认为模型在位。

用途：`tools/bench-llm.py` 把 ai-service 的 `AI_OLLAMA_URL` 指向本桩，隔离真实 LLM
波动，从而干净地对比「worker 池 / 连接复用 / 流式」对吞吐与延迟的影响。
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

DEFAULT_MODEL = "qwen2.5:0.5b"


def _chat_response_text() -> str:
    return json.dumps(
        {
            "text": "建议多休息、适量饮水，如症状持续或加重请线下就诊咨询。",
            "language": "zh-CN",
            "refused": False,
            "refusalReason": None,
        },
        ensure_ascii=False,
    )


class Handler(BaseHTTPRequestHandler):
    # 类级可调参数（由 argparse 启动时写入）
    latency_ms = 200
    first_token_ms = 80
    break_stream = False  # True → 对 stream=True 返回 500，用于验证流式回退非流式

    def log_message(self, *args):  # 静默
        pass

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        return json.loads(raw.decode("utf-8")) if raw else {}

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/api/tags":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"models": [{"name": DEFAULT_MODEL, "model": DEFAULT_MODEL}]}).encode())
            return
        self.send_response(404)
        self.end_headers()

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/api/generate":
            self.send_response(404)
            self.end_headers()
            return
        body = self._body()
        model = body.get("model", DEFAULT_MODEL)
        stream = bool(body.get("stream", False))
        resp_text = _chat_response_text()

        if not stream:
            time.sleep(self.latency_ms / 1000.0)
            payload = json.dumps({"model": model, "response": resp_text}).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return

        # 降级验证：强制让流式请求失败 → ai-service 应回退非流式且不向用户报错。
        if self.break_stream:
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "injected stream failure"}).encode("utf-8"))
            return

        # 流式：把「模型应返回的 JSON 字符串」切成若干分片陆续吐出（模拟首 token 延迟 + 余下时间均摊）。
        # 注意：与真实 Ollama + format=json 一致——stream 的 response 字段就是 JSON 文本本身，
        # 客户端累积后仍需是合法 JSON（chat 执行器会 parse_json_strict）。
        self.send_response(200)
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        w = self.wfile

        def emit(obj):
            line = json.dumps(obj, ensure_ascii=False) + "\n"
            w.write(line.encode("utf-8"))
            w.flush()

        # 将 JSON 字符串切成 4 片（避免切断引号导致中间态非法，但累积后合法）
        full = resp_text
        pieces = []
        n = 4
        step = max(1, len(full) // n)
        for i in range(0, len(full), step):
            pieces.append(full[i:i + step])
        if not pieces:
            pieces = [full]

        time.sleep(self.first_token_ms / 1000.0)
        rest = self.latency_ms - self.first_token_ms
        step_s = max(0.001, (rest / 1000.0) / max(1, len(pieces)))
        for piece in pieces:
            time.sleep(step_s)
            emit({"response": piece, "done": False})
        emit({"response": "", "done": True})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11499)
    ap.add_argument("--latency", type=float, default=200, help="非流式/总生成耗时（毫秒）")
    ap.add_argument("--first-token", type=float, default=80, help="流式首 token 延迟（毫秒）")
    ap.add_argument("--break-stream", action="store_true",
                    help="对 stream=True 请求返回 500，用于验证流式回退非流式")
    args = ap.parse_args()

    Handler.latency_ms = args.latency
    Handler.first_token_ms = args.first_token
    Handler.break_stream = args.break_stream

    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"stub-ollama-llm listening on 127.0.0.1:{args.port} | latency={args.latency}ms firstToken={args.first_token}ms",
          flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
