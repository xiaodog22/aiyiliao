"""
健康科普知识库入库脚本（2026-10-22；2026-11-21 治理合并改造）

用途：
    把科普内容切片经 Ollama embedding 生成向量，写入 Qdrant health_kb collection。

数据源（单一事实源，2026-11-21 起）：
    backend/ai-service/data/knowledge-articles.json
    —— 由仓库根 `node tools/export-knowledge-kb.js` 从 miniprogram/utils/knowledge-kb.js 生成。
    本脚本**不再手抄**科普内容（原 ARTICLES/VIDEOS 字面量与前端标题已漂移 9/10 条，已删除）。
    改科普只改 knowledge-kb.js，然后：重跑导出脚本 → 重跑本脚本入库。

前置：
    1. 已生成 data/knowledge-articles.json（node tools/export-knowledge-kb.js）
    2. Ollama 在跑（默认 http://127.0.0.1:11434），且已 `ollama pull nomic-embed-text`
    3. Qdrant 在跑（默认 http://127.0.0.1:6333），无鉴权

用法：
    cd backend/ai-service
    .venv\\Scripts\\python.exe scripts\\ingest_knowledge_kb.py
    # 可选：--qdrant http://127.0.0.1:6333 --ollama http://127.0.0.1:11434 --model nomic-embed-text

切片策略：
    - 每篇文章的每个 section 作为一个 chunk（h + p 拼接）
    - 每个视频的每条 tip 作为一个 chunk
    - 元数据：documentId / chunkId / title / source / publishedAt / category / chunkType
      / embeddingModel / kbSource（2026-11-21 新增，入库口径可追溯）

幂等：
    - chunk 命名规则稳定（documentId_chunkIndex），重复跑 upsert 覆盖同 ID
    - 先检查 collection 是否存在；不存在则按向量维度创建（48 for nomic-embed-text）
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

SERVICE_DIR = Path(__file__).resolve().parent.parent
KB_JSON_PATH = SERVICE_DIR / "data" / "knowledge-articles.json"


def load_kb() -> tuple[list[dict], list[dict], str]:
    """读取同源导出文件；缺失时明确报错并给出生成命令（不静默降级到旧副本）。"""
    if not KB_JSON_PATH.exists():
        sys.exit(
            f"✗ 缺少数据源 {KB_JSON_PATH}\n"
            "  请先在仓库根执行：node tools/export-knowledge-kb.js"
        )
    doc = json.loads(KB_JSON_PATH.read_text(encoding="utf-8"))
    articles = doc.get("articles") or []
    videos = doc.get("videos") or []
    if not articles and not videos:
        sys.exit(f"✗ {KB_JSON_PATH} 无内容（articles/videos 均为空）")
    return articles, videos, doc.get("sourceFile", "data/knowledge-articles.json")


# ---------------- HTTP 工具 ----------------

def _http_post(url: str, payload: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_put(url: str, payload: dict, timeout: float = 30.0) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_get(url: str, timeout: float = 10.0) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        return e.code, {}


# ---------------- 业务流程 ----------------

def check_ollama(ollama_url: str, model: str) -> None:
    print(f"[1/4] 检查 Ollama embedding 模型：{ollama_url}  model={model}")
    status, tags = _http_get(f"{ollama_url.rstrip('/')}/api/tags")
    if status != 200:
        sys.exit(f"  ✗ Ollama 不可达（HTTP {status}）。请先启动 Ollama。")
    names = [m.get("name", "") for m in tags.get("models", [])]
    if not any(n.startswith(model) for n in names):
        sys.exit(f"  ✗ 模型 {model} 未安装。请先执行：ollama pull {model}\n  当前已装：{names}")
    print(f"  ✓ Ollama 可达，已装模型：{names}")


def get_embedding(ollama_url: str, model: str, text: str) -> list[float]:
    resp = _http_post(
        f"{ollama_url.rstrip('/')}/api/embeddings",
        {"model": model, "prompt": text},
    )
    vec = resp.get("embedding")
    if not vec:
        raise RuntimeError(f"embedding 返回空：{resp}")
    return vec


def ensure_collection(qdrant_url: str, collection: str, vector_dim: int) -> None:
    print(f"[2/4] 检查 Qdrant collection：{qdrant_url}  collection={collection}")
    status, _ = _http_get(f"{qdrant_url.rstrip('/')}/collections/{collection}")
    if status == 200:
        print(f"  ✓ collection 已存在，将 upsert（同 ID 覆盖）")
        return
    if status != 404:
        sys.exit(f"  ✗ 查询 collection 失败（HTTP {status}）")
    print(f"  → collection 不存在，创建（向量维度={vector_dim}）")
    _http_put(
        f"{qdrant_url.rstrip('/')}/collections/{collection}",
        {
            "vectors": {
                "size": vector_dim,
                "distance": "Cosine",
            }
        },
    )
    print(f"  ✓ collection 已创建")


def build_chunks(articles: list[dict], videos: list[dict], kb_source: str) -> list[dict]:
    chunks = []
    for art in articles:
        for idx, sec in enumerate(art["sections"]):
            chunks.append({
                "documentId": art["id"],
                "chunkId": f"{art['id']}_p{idx+1}",
                "content": f"【{sec['h']}】{sec['p']}",
                "title": art["title"],
                "source": art["source"],
                "publishedAt": art["publishedAt"],
                "category": art["category"],
                "chunkType": "article",
            })
    for vid in videos:
        for idx, tip in enumerate(vid["tips"]):
            chunks.append({
                "documentId": vid["id"],
                "chunkId": f"{vid['id']}_tip{idx+1}",
                "content": tip,
                "title": vid["title"],
                "source": vid["source"],
                "publishedAt": vid.get("publishedAt"),
                "category": vid["category"],
                "chunkType": "video_tip",
            })
    for ch in chunks:
        ch["kbSource"] = kb_source
    return chunks


def upsert_chunks(qdrant_url: str, collection: str, chunks: list[dict], ollama_url: str, model: str) -> None:
    print(f"[3/4] 切片 embedding + upsert（共 {len(chunks)} 条）")
    points = []
    for i, ch in enumerate(chunks, 1):
        vec = get_embedding(ollama_url, model, ch["content"])
        # 用 chunkId 的 hash 作为 uint64 point id（Qdrant 要求）
        import hashlib
        point_id = int(hashlib.sha256(ch["chunkId"].encode("utf-8")).hexdigest()[:16], 16)
        points.append({
            "id": point_id,
            "vector": vec,
            "payload": {
                "documentId": ch["documentId"],
                "chunkId": ch["chunkId"],
                "content": ch["content"],
                "title": ch["title"],
                "source": ch["source"],
                "publishedAt": ch["publishedAt"],
                "category": ch["category"],
                "chunkType": ch["chunkType"],
                # 入库口径可追溯（2026-11-21 治理合并）：embedding 模型 + 数据源文件
                "embeddingModel": model,
                "kbSource": ch["kbSource"],
            },
        })
        print(f"  [{i}/{len(chunks)}] {ch['chunkId']}  ({len(ch['content'])} 字)")
        time.sleep(0.05)  # 礼貌限流

    print(f"[4/4] 批量 upsert 到 Qdrant")
    _http_put(
        f"{qdrant_url.rstrip('/')}/collections/{collection}/points?wait=true",
        {"points": points},
        timeout=60.0,
    )
    print(f"  ✓ 已写入 {len(points)} 个 points")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--qdrant", default="http://127.0.0.1:6333")
    ap.add_argument("--ollama", default="http://127.0.0.1:11434")
    ap.add_argument("--model", default="nomic-embed-text")
    ap.add_argument("--collection", default="health_kb")
    args = ap.parse_args()

    print("=" * 60)
    print("健康科普知识库入库脚本（同源数据：data/knowledge-articles.json）")
    print("=" * 60)

    articles, videos, kb_source = load_kb()
    print(f"  数据源：{kb_source}（{len(articles)} 图文 + {len(videos)} 视频）")

    check_ollama(args.ollama, args.model)

    # 探测向量维度（用第一个 chunk 试跑）
    dim_probe = get_embedding(args.ollama, args.model, "维度探测")
    vector_dim = len(dim_probe)
    print(f"  向量维度：{vector_dim}")

    ensure_collection(args.qdrant, args.collection, vector_dim)

    chunks = build_chunks(articles, videos, kb_source)
    upsert_chunks(args.qdrant, args.collection, chunks, args.ollama, args.model)

    print()
    print("=" * 60)
    print("✓ 入库完成。下一步：")
    print(f"  1. 确认 Qdrant 可达：{args.qdrant}")
    print(f"  2. 在 backend/deploy/env.local 打开：")
    print(f"     AI_RAG_ENABLED=true")
    print(f"     AI_QDRANT_URL={args.qdrant}")
    print(f"     AI_EMBEDDING_MODEL={args.model}")
    print(f"  3. 重启 ai-service：backend/deploy/restart.bat")
    print("=" * 60)


if __name__ == "__main__":
    main()
