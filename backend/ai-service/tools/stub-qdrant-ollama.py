"""本地桩：同时模拟 Qdrant REST 与 Ollama /api/embeddings（仅开发验证用，不参与生产链路）。

用途
----
在没有真实 Qdrant、没有 embedding 模型（nomic-embed-text）的机器上，验证
`scripts/rag_ingest.py` 的幂等、版本清理与回滚行为。

支持的接口
-----------
Qdrant 侧（子集）
    PUT  /collections/{c}/points?wait=true      upsert（按 id 覆盖）
    POST /collections/{c}/points/delete?wait=true  按 filter 删除（must / must_not）
    GET  /collections/{c}/points/count?exact=true 精确点数
    GET  /_dump                                  调试：导出全部点（供人工核对）

Ollama 侧
    POST /api/embeddings                        返回固定维度的确定性向量

⚠️ 桩不做鉴权、不做持久化（进程退出即丢），仅供本机自测。禁止指向生产地址。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

DIM = 8
STORE: dict[str, dict] = {}
LOCK = threading.Lock()

_COLL_RE = re.compile(r"^/collections/([^/]+)/points$")
_DELETE_RE = re.compile(r"^/collections/([^/]+)/points/delete$")
_COUNT_RE = re.compile(r"^/collections/([^/]+)/points/count$")


def _fake_vector(text: str) -> list[float]:
    """确定性伪向量：同样文本 → 同样向量（仅用于验证覆盖/幂等语义）。"""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return [round(digest[i] / 255.0, 4) for i in range(DIM)]


def _matches(payload: dict, conditions: list) -> bool:
    for cond in conditions or []:
        key = cond.get("key")
        expected = (cond.get("match") or {}).get("value")
        if payload.get(key) != expected:
            return False
    return True


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_args) -> None:  # 静音
        pass

    def _json(self, code: int, body: dict) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        if path == "/_dump":
            with LOCK:
                self._json(200, {"count": len(STORE), "points": list(STORE.values())})
            return
        if _COUNT_RE.match(path):
            with LOCK:
                self._json(200, {"result": {"count": len(STORE)}})
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        body = self._read_json()
        if path == "/api/embeddings":
            prompt = str(body.get("prompt") or "")
            self._json(200, {"embedding": _fake_vector(prompt)})
            return
        if _DELETE_RE.match(path):
            filt = body.get("filter") or {}
            must = filt.get("must") or []
            must_not = filt.get("must_not") or []
            removed = 0
            with LOCK:
                for pid, point in list(STORE.items()):
                    payload = point.get("payload") or {}
                    if not _matches(payload, must):
                        continue
                    # must_not 为空 = 不排除任何点（对齐 Qdrant 语义；
                    # 早前版本把空列表当成"匹配"，导致 must 命中后又被排除 → deleted=0）
                    if must_not and _matches(payload, must_not):
                        continue
                    STORE.pop(pid, None)
                    removed += 1
            self._json(200, {"result": {"deleted": removed}})
            return
        self._json(404, {"error": "not found"})

    def do_PUT(self) -> None:  # noqa: N802
        path = self.path.split("?")[0]
        body = self._read_json()
        if _COLL_RE.match(path):
            points = body.get("points") or []
            with LOCK:
                for point in points:
                    STORE[str(point["id"])] = point
            self._json(200, {"result": {"status": "completed", "count": len(points)}})
            return
        self._json(404, {"error": "not found"})


def main() -> int:
    parser = argparse.ArgumentParser(description="本地 Qdrant + Ollama embedding 桩")
    parser.add_argument("--port", type=int, default=6399)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"[stub] listening http://127.0.0.1:{args.port}  (qdrant + ollama stub)", flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
