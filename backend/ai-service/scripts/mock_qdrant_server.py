"""
轻量 Qdrant HTTP 兼容服务器（仅本地开发验证用，非生产）。

实现 rag.py + ingest_knowledge_kb.py 用到的 4 个端点：
  - GET  /collections/{name}                          存在性检查
  - PUT  /collections/{name}                          创建 collection
  - PUT  /collections/{name}/points?wait=true         批量 upsert
  - POST /collections/{name}/points/search             余弦相似度 top-k
  - GET  /healthz                                      健康检查

数据全在内存，进程退出即丢。用于在无法部署真实 Qdrant（docker/二进制不可用）时，
端到端验证 rag.py → 执行器 → citations 链路。生产部署必须用真实 Qdrant。

用法：
  .venv\\Scripts\\python.exe scripts\\mock_qdrant_server.py
  # 可选：--port 6333 --host 127.0.0.1
"""

from __future__ import annotations

import argparse
import json
import math
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


# 内存数据：collections[name] = {"dim": int, "points": {id: {"vector": [...], "payload": {...}}}}
COLLECTIONS: dict[str, dict] = {}
LOCK = threading.Lock()
START_TS = time.time()


def _cosine(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


class Handler(BaseHTTPRequestHandler):
    # 静默默认日志（改用自定义输出）
    def log_message(self, fmt, *args):
        pass

    def _send_json(self, status: int, body: dict):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    # ---- 路由 ----
    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/healthz" or path == "/":
            self._send_json(200, {"title": "qdrant-mock", "version": "dev-mock", "uptime": time.time() - START_TS})
            return
        if path.startswith("/collections/"):
            name = path[len("/collections/"):]
            with LOCK:
                if name in COLLECTIONS:
                    col = COLLECTIONS[name]
                    self._send_json(200, {
                        "result": {
                            "status": "green",
                            "vectors_count": len(col["points"]),
                            "config": {"params": {"vector_size": col["dim"], "distance": "Cosine"}},
                        }
                    })
                else:
                    self._send_json(404, {"status": "collection not found"})
            return
        self._send_json(404, {"error": "not found"})

    def do_PUT(self):
        path = self.path.split("?")[0]
        body = self._read_json()
        if path.startswith("/collections/") and not path.endswith("/points"):
            name = path[len("/collections/"):]
            vectors_cfg = body.get("vectors", {})
            dim = vectors_cfg.get("size") if isinstance(vectors_cfg, dict) else None
            if dim is None:
                self._send_json(400, {"error": "missing vectors.size"})
                return
            with LOCK:
                COLLECTIONS[name] = {"dim": int(dim), "points": {}}
            print(f"[mock-qdrant] collection created: {name} dim={dim}")
            self._send_json(200, {"result": True, "status": "ok"})
            return
        if path.startswith("/collections/") and path.endswith("/points"):
            name = path.split("/")[2]
            points = body.get("points", [])
            with LOCK:
                col = COLLECTIONS.get(name)
                if col is None:
                    self._send_json(404, {"error": f"collection {name} not found"})
                    return
                upserted = 0
                for p in points:
                    pid = p["id"]
                    col["points"][pid] = {
                        "vector": p["vector"],
                        "payload": p.get("payload", {}),
                    }
                    upserted += 1
            print(f"[mock-qdrant] upserted {upserted} points into {name} (total={len(col['points'])})")
            self._send_json(200, {"result": {"operation_id": 0, "status": "completed"}, "status": "ok"})
            return
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        body = self._read_json()
        if path.startswith("/collections/") and path.endswith("/points/search"):
            name = path.split("/")[2]
            query_vec = body.get("vector", [])
            limit = body.get("limit", 5)
            threshold = body.get("score_threshold", 0.0)
            with_payload = body.get("with_payload", True)
            with LOCK:
                col = COLLECTIONS.get(name)
                if col is None:
                    self._send_json(404, {"error": f"collection {name} not found"})
                    return
                scored = []
                for pid, pt in col["points"].items():
                    if len(pt["vector"]) != len(query_vec):
                        continue
                    score = _cosine(query_vec, pt["vector"])
                    if score >= threshold:
                        hit = {"id": pid, "score": score}
                        if with_payload:
                            hit["payload"] = pt["payload"]
                        scored.append(hit)
            scored.sort(key=lambda h: -h["score"])
            top = scored[:limit]
            print(f"[mock-qdrant] search in {name}: query_dim={len(query_vec)} total={len(col['points'])} hits={len(top)} top={top[0]['score']:.3f if top else 0}")
            self._send_json(200, {"result": top})
            return
        self._send_json(404, {"error": "not found"})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=6333)
    args = ap.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"[mock-qdrant] listening on http://{args.host}:{args.port}")
    print(f"[mock-qdrant] WARNING: 仅本地开发验证，生产必须用真实 Qdrant")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[mock-qdrant] shutdown")


if __name__ == "__main__":
    main()
