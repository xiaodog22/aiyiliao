"""rag_redis_seed.py —— 院内知识库 → Redis 向量化入库（V23 演示版，2026-10-24）。

用途：把 config/hospital-knowledge.json 的四个场景知识片段向量化写入 Redis，
供 ai-service RAG（AI_RAG_STORE=redis）检索。幂等可重跑：SET 覆盖 + SADD 幂等。

结构：
  - SET {prefix}index          → 全部 chunkId
  - STR {prefix}vec:{chunkId}  → JSON {vector, documentId, chunkId, content, title, source, publishedAt}

用法（ai-service/.venv 环境）：
  .venv/Scripts/python.exe tools/rag_redis_seed.py [--kb config/hospital-knowledge.json]
默认连 redis://127.0.0.1:6379/0；前缀 ai:rag:；Ollama 默认 http://127.0.0.1:11434。

前置：Redis 已启动（D:\\Redis\\redis-server.exe）；Ollama 已 pull nomic-embed-text：
  ollama pull nomic-embed-text
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent


def embed(text: str, ollama_url: str, model: str) -> list[float]:
    body = json.dumps({"model": model, "prompt": text}).encode("utf-8")
    req = urllib.request.Request(
        ollama_url.rstrip("/") + "/api/embeddings", data=body, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    emb = payload.get("embedding")
    if not isinstance(emb, list) or not emb:
        raise RuntimeError("Ollama 未返回 embedding 数组")
    return emb


def main() -> int:
    ap = argparse.ArgumentParser(description="院内知识库 → Redis 向量入库")
    ap.add_argument("--kb", default=str(SERVICE_DIR / "config" / "hospital-knowledge.json"))
    ap.add_argument("--redis-url", default="redis://127.0.0.1:6379/0")
    ap.add_argument("--prefix", default="ai:rag:")
    ap.add_argument("--ollama-url", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="nomic-embed-text")
    ap.add_argument("--batch", type=int, default=8, help="并发 embedding 批量（串行 urllib，占位保留）")
    args = ap.parse_args()

    kb_path = Path(args.kb)
    if not kb_path.exists():
        print(f"[rag_redis_seed] 知识库不存在: {kb_path}", file=sys.stderr)
        return 2
    kb = json.loads(kb_path.read_text(encoding="utf-8"))
    scenarios = kb.get("scenarios", {})
    if not isinstance(scenarios, dict) or not scenarios:
        print("[rag_redis_seed] 知识库缺少 scenarios 段", file=sys.stderr)
        return 2
    version = kb.get("version", "unknown")

    import redis as redis_mod

    client = redis_mod.Redis.from_url(
        args.redis_url, decode_responses=True, socket_timeout=15, protocol=2  # Redis 3.x 无 RESP3
    )
    try:
        client.ping()
    except Exception as exc:
        print(f"[rag_redis_seed] Redis 不可达: {exc}", file=sys.stderr)
        return 2

    chunks: list[dict] = []
    for scenario, cfg in scenarios.items():
        knowledge = cfg.get("knowledge") if isinstance(cfg, dict) else None
        if not isinstance(knowledge, list):
            continue
        for i, item in enumerate(knowledge):
            if not isinstance(item, dict):
                continue
            topic = str(item.get("topic") or "")
            content = str(item.get("content") or "")
            if not content:
                continue
            slug = "".join(ch for ch in topic if ch not in " ：:（）()").strip()[:30] or "t"
            chunks.append({
                "chunkId": f"{scenario}:{slug}:{i}",
                "documentId": scenario,
                "text": f"{topic}。{content}" if topic else content,
                "title": topic or scenario,
                "source": str(item.get("source") or "config/hospital-knowledge.json"),
                "publishedAt": str(item.get("published_at") or version),
            })
    print(f"[rag_redis_seed] 知识片段 {len(chunks)} 条（version={version}）")

    t0 = time.time()
    ok = 0
    failed = 0
    for n, chunk in enumerate(chunks, 1):
        try:
            vec = embed(chunk["text"], args.ollama_url, args.model)
            doc = {
                "vector": vec,
                "documentId": chunk["documentId"],
                "chunkId": chunk["chunkId"],
                "content": chunk["text"],
                "title": chunk["title"],
                "source": chunk["source"],
                "publishedAt": chunk["publishedAt"],
            }
            client.set(args.prefix + "vec:" + chunk["chunkId"], json.dumps(doc, ensure_ascii=False))
            client.sadd(args.prefix + "index", chunk["chunkId"])
            ok += 1
        except Exception as exc:
            failed += 1
            print(f"[rag_redis_seed] chunk 失败: {chunk['chunkId']} | {exc.__class__.__name__}")
        if n % 5 == 0 or n == len(chunks):
            print(f"[rag_redis_seed] 进度 {n}/{len(chunks)}（已入 {ok}，失败 {failed}）")

    indexed = client.scard(args.prefix + "index")
    client.close()
    print(f"[rag_redis_seed] 完成：成功 {ok}，失败 {failed}，索引条目 {indexed}，耗时 {time.time() - t0:.1f}s")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
