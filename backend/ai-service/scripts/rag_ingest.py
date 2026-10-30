"""RAG 入库 pipeline（独立命令，不挂在任何 HTTP 路由上）。

作用：把前端科普内容（`miniprogram/utils/knowledge-kb.js` 的 ARTICLES）切成片段 →
调 Ollama embedding → **幂等 upsert** 到 Qdrant，供 `app/executors/rag.py` 检索。

设计要点
--------
1. **读写分离**：本脚本只写；读路径在 `executors/rag.py`（RAG 任务 / CHAT citations）。
2. **幂等**：point id = `uuid5(命名空间, "{doc_id}::{chunk_id}")` —— 与内容长度、运行次数、版本号无关，
   重复运行是**覆盖**而不是新增；配 `--purge-stale` 清掉同 doc 的旧版本残留。
3. **默认不写库**：不带 `--apply` 一律 dry-run（只打印计划）；Qdrant 非本机时必须再加 `--allow-remote`。
4. **可重跑**：embedding / upsert 均带指数退避重试；单条失败只记账不中断，退出码 1 提示重跑。
5. **日志脱敏**：只打印 doc_id / chunk_id / 字符数 / 维度 / 命中数；正文最多 20 字预览，不落全文。
6. **元数据**：source / doc_id / chunk_id / version / dept / scene / permission / ingested_at
   + 检索侧需要的 documentId / chunkId / content / title（`rag.py` 读的是 camelCase 或 `*_id`）。

用法
----
    cd backend/ai-service
    # 1) 先看计划（不联网、不写库）
    .venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ../../miniprogram/utils/knowledge-kb.js

    # 2) 本地 Qdrant 小批量试写
    .venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ../../miniprogram/utils/knowledge-kb.js \
        --apply --limit 2 --collection health_kb_test

    # 3) 全量（确认 collection 已按 embedding 维度建好）
    .venv/Scripts/python.exe scripts/rag_ingest.py --from-kb ... --apply --version kb-20261022

    # 4) 回滚：按 version 删除
    .venv/Scripts/python.exe scripts/rag_ingest.py --delete-version kb-20261022 --apply
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

import httpx

# 固定命名空间：换机器/换时间/换版本，同一 (doc_id, chunk_id) 的 point id 都不变
POINT_NAMESPACE = uuid.UUID("1b5c6f0e-8a4d-4b7f-9c2e-3d5a7b9c1e0f")

DEFAULT_MAX_CHARS = 400
DEFAULT_BATCH_SIZE = 16
DEFAULT_MAX_RETRIES = 3
PREVIEW_CHARS = 20
LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


# --------------------------------------------------------------------------- 数据模型
@dataclass
class Chunk:
    doc_id: str
    chunk_id: str
    title: str
    section: str
    content: str
    source: str
    scene: str
    dept: str
    published_at: Optional[str] = None

    @property
    def text(self) -> str:
        """入库文本 = 小节标题 + 正文（提升检索命中；title 另存 payload）。"""
        return f"{self.section}\n{self.content}".strip() if self.section else self.content

    @property
    def point_id(self) -> str:
        return str(uuid.uuid5(POINT_NAMESPACE, f"{self.doc_id}::{self.chunk_id}"))


@dataclass
class Stats:
    docs: int = 0
    chunks: int = 0
    upserted: int = 0
    batches: int = 0
    retries: int = 0
    failed: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "docs": self.docs,
            "chunks": self.chunks,
            "upserted": self.upserted,
            "batches": self.batches,
            "retries": self.retries,
            "failed": self.failed,
        }


# --------------------------------------------------------------------------- 输入
def load_articles_from_kb(path: Path) -> list[dict]:
    """用 node 读取前端 CommonJS 内容库（比正则解析 JS 可靠）。"""
    script = (
        "const kb = require(process.argv[1]);"
        "process.stdout.write(JSON.stringify(kb.ARTICLES || []));"
    )
    try:
        out = subprocess.run(
            ["node", "-e", script, str(path.resolve())],
            capture_output=True, check=True, timeout=30,
        )
    except FileNotFoundError:
        raise SystemExit("未找到 node：请改用 --input <已切好的 JSON>，或先安装 Node.js")
    except subprocess.CalledProcessError as exc:
        detail = exc.stderr.decode("utf-8", "replace")[:200]
        raise SystemExit(f"读取前端内容库失败（node 退出码 {exc.returncode}）：{detail}")
    return json.loads(out.stdout.decode("utf-8") or "[]")


def load_articles_from_json(path: Path) -> list[dict]:
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("articles") or data.get("documents") or []
    if not isinstance(data, list):
        raise SystemExit("--input 必须是数组，或含 articles/documents 数组的对象")
    return data


def _section_paragraphs(section: dict) -> str:
    body = section.get("p") or section.get("body") or section.get("content") or []
    if isinstance(body, str):
        return body.strip()
    return "\n".join(str(p).strip() for p in body if str(p).strip())


def build_chunks(article: dict, *, max_chars: int = DEFAULT_MAX_CHARS,
                 source_label: str = "knowledge-kb.js") -> list[Chunk]:
    """按小节切块；单节超长时按段落继续分组（组内不跨节）。"""
    doc_id = str(article.get("id") or article.get("doc_id") or "").strip()
    if not doc_id:
        raise SystemExit("文章缺少 id/doc_id，无法生成稳定 point id")
    title = str(article.get("title") or doc_id)
    category = str(article.get("category") or "健康科普")
    dept = str(article.get("dept") or "")
    source = str(article.get("source") or source_label)
    published_at = article.get("publishedAt") or None

    sections = article.get("sections") or []
    chunks: list[Chunk] = []
    seq = 0

    def push(section_title: str, text: str) -> None:
        nonlocal seq
        text = text.strip()
        if not text:
            return
        seq += 1
        chunks.append(Chunk(
            doc_id=doc_id, chunk_id=f"c{seq:02d}", title=title, section=section_title,
            content=text, source=source, scene=category, dept=dept, published_at=published_at,
        ))

    for section in sections:
        heading = str(section.get("h") or section.get("heading") or "").strip()
        body = _section_paragraphs(section)
        if not body:
            continue
        if len(body) <= max_chars:
            push(heading, body)
            continue
        # 超长：按段落累加到 max_chars
        buf: list[str] = []
        size = 0
        for paragraph in body.split("\n"):
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            if size + len(paragraph) > max_chars and buf:
                push(heading, "\n".join(buf))
                buf, size = [paragraph], len(paragraph)
            else:
                buf.append(paragraph)
                size += len(paragraph)
        if buf:
            push(heading, "\n".join(buf))

    if not chunks:  # 没有 sections 的兜底：整篇按段落切
        body = str(article.get("content") or article.get("summary") or "").strip()
        buf, size = [], 0
        for paragraph in body.split("\n"):
            paragraph = paragraph.strip()
            if not paragraph:
                continue
            if size + len(paragraph) > max_chars and buf:
                push(title, "\n".join(buf))
                buf, size = [paragraph], len(paragraph)
            else:
                buf.append(paragraph)
                size += len(paragraph)
        if buf:
            push(title, "\n".join(buf))

    return chunks


# --------------------------------------------------------------------------- 元数据
def build_payload(chunk: Chunk, *, version: str, ingested_at: str,
                  permission: Iterable[str] = ("public",)) -> dict:
    """payload 同时满足「入库审计」与「rag.py 读取」两套字段名。"""
    return {
        # 检索侧读取（rag.py 支持 documentId/document_id、chunkId/chunk_id）
        "documentId": chunk.doc_id,
        "chunkId": chunk.chunk_id,
        "content": chunk.content,
        "title": chunk.title,
        "source": chunk.source,
        "publishedAt": chunk.published_at,
        # 入库审计 / 幂等 / 回滚
        "doc_id": chunk.doc_id,
        "chunk_id": chunk.chunk_id,
        "version": version,
        "dept": chunk.dept,
        "scene": chunk.scene,
        "permission": list(permission),
        "ingested_at": ingested_at,
        "section": chunk.section,
        "content_hash": hashlib.sha256(chunk.text.encode("utf-8")).hexdigest()[:16],
        "content_len": len(chunk.content),
    }


def preview(text: str, limit: int = PREVIEW_CHARS) -> str:
    """日志只留极短预览（不落全文）。"""
    flat = " ".join(text.split())
    return flat if len(flat) <= limit else flat[:limit] + "…"


# --------------------------------------------------------------------------- 外部依赖
def embed_text(*, ollama_url: str, model: str, text: str, timeout: float = 30.0,
               transport: Optional[httpx.BaseTransport] = None) -> list[float]:
    with httpx.Client(timeout=timeout, trust_env=False, transport=transport) as client:
        resp = client.post(f"{ollama_url.rstrip('/')}/api/embeddings",
                           json={"model": model, "prompt": text})
        resp.raise_for_status()
        vector = resp.json().get("embedding")
    if not isinstance(vector, list) or not vector:
        raise RuntimeError("embedding 返回为空")
    return vector


class QdrantHttp:
    """Qdrant REST 最小客户端（upsert / delete-by-filter / count）。"""

    def __init__(self, base_url: str, collection: str, *, api_key: str = "",
                 timeout: float = 20.0, transport: Optional[httpx.BaseTransport] = None) -> None:
        self.base = base_url.rstrip("/")
        self.collection = collection
        self.api_key = api_key
        self.timeout = timeout
        self.transport = transport

    def _headers(self) -> dict:
        return {"api-key": self.api_key} if self.api_key else {}

    def _url(self, suffix: str) -> str:
        return f"{self.base}/collections/{self.collection}/{suffix}"

    def upsert(self, points: list[dict]) -> None:
        with httpx.Client(timeout=self.timeout, trust_env=False, transport=self.transport) as client:
            resp = client.put(self._url("points?wait=true"), json={"points": points},
                              headers=self._headers())
            resp.raise_for_status()

    def delete_by_filter(self, must: list[dict], must_not: Optional[list[dict]] = None) -> None:
        body: dict = {"filter": {"must": must}}
        if must_not:
            body["filter"]["must_not"] = must_not
        with httpx.Client(timeout=self.timeout, trust_env=False, transport=self.transport) as client:
            resp = client.post(self._url("points/delete?wait=true"), json=body,
                               headers=self._headers())
            resp.raise_for_status()

    def count(self) -> Optional[int]:
        with httpx.Client(timeout=self.timeout, trust_env=False, transport=self.transport) as client:
            resp = client.get(self._url("points/count"), params={"exact": "true"},
                              headers=self._headers())
            resp.raise_for_status()
            return int(resp.json().get("result", {}).get("count", 0))


# --------------------------------------------------------------------------- 重试
def with_retry(action: Callable[[], Any], *, attempts: int = DEFAULT_MAX_RETRIES,
               base_delay: float = 0.4, on_retry: Optional[Callable[[int, Exception], None]] = None) -> Any:
    """指数退避重试（attempts 含首次）。最后一次失败原样抛出。"""
    last: Optional[Exception] = None
    for idx in range(max(1, attempts)):
        try:
            return action()
        except Exception as exc:  # 网络/5xx/超时都按可重试处理；4xx 由调用方先用 raise_for_status 抛
            last = exc
            if idx >= attempts - 1:
                break
            if on_retry:
                on_retry(idx + 1, exc)
            time.sleep(base_delay * (2 ** idx))
    raise last  # type: ignore[misc]


# --------------------------------------------------------------------------- 主流程
def ingest(
    chunks: list[Chunk],
    *,
    qdrant: Any,
    embed: Callable[[str], list[float]],
    version: str,
    batch_size: int = DEFAULT_BATCH_SIZE,
    max_retries: int = DEFAULT_MAX_RETRIES,
    base_delay: float = 0.4,
    now: Optional[datetime] = None,
    purge_stale: bool = True,
    log: Callable[[str], None] = print,
) -> Stats:
    """把 chunks 写入 Qdrant；返回统计（含失败清单，便于重跑）。"""
    stats = Stats(docs=len({c.doc_id for c in chunks}), chunks=len(chunks))
    ingested_at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    def count_retry(_attempt: int, _exc: Exception) -> None:
        stats.retries += 1

    pending: list[dict] = []
    for chunk in chunks:
        try:
            vector = with_retry(lambda c=chunk: embed(c.text), attempts=max_retries,
                                base_delay=base_delay, on_retry=count_retry)
        except Exception as exc:
            stats.failed.append(f"{chunk.doc_id}/{chunk.chunk_id}:embed:{exc.__class__.__name__}")
            log(f"  [FAIL] embed {chunk.doc_id}/{chunk.chunk_id} ({exc.__class__.__name__})")
            continue
        pending.append({
            "id": chunk.point_id,
            "vector": vector,
            "payload": build_payload(chunk, version=version, ingested_at=ingested_at),
        })
        if len(pending) >= max(1, batch_size):
            _flush(pending, qdrant, stats, max_retries, base_delay, count_retry, log)
            pending = []

    if pending:
        _flush(pending, qdrant, stats, max_retries, base_delay, count_retry, log)

    if purge_stale and stats.failed == []:
        for doc_id in sorted({c.doc_id for c in chunks}):
            try:
                with_retry(
                    lambda d=doc_id: qdrant.delete_by_filter(
                        must=[{"key": "doc_id", "match": {"value": d}}],
                        must_not=[{"key": "version", "match": {"value": version}}],
                    ),
                    attempts=max_retries, base_delay=base_delay, on_retry=count_retry,
                )
            except Exception as exc:
                stats.failed.append(f"{doc_id}:purge:{exc.__class__.__name__}")
                log(f"  [FAIL] purge stale {doc_id} ({exc.__class__.__name__})")

    return stats


def _flush(batch: list[dict], qdrant: Any, stats: Stats, max_retries: int,
           base_delay: float, on_retry: Callable[[int, Exception], None],
           log: Callable[[str], None]) -> None:
    try:
        with_retry(lambda: qdrant.upsert(batch), attempts=max_retries,
                   base_delay=base_delay, on_retry=on_retry)
    except Exception as exc:
        # 整批失败：逐条记账（保留 point id，重跑即覆盖，不会重复）
        for point in batch:
            doc_id = point["payload"]["doc_id"]
            chunk_id = point["payload"]["chunk_id"]
            stats.failed.append(f"{doc_id}/{chunk_id}:upsert:{exc.__class__.__name__}")
        log(f"  [FAIL] upsert batch({len(batch)}) ({exc.__class__.__name__})")
        return
    stats.upserted += len(batch)
    stats.batches += 1


def plan_report(chunks: list[Chunk], *, version: str, collection: str,
                batch_size: int, limit: int, source_label: str) -> dict:
    selected = chunks[:limit] if limit and limit > 0 else chunks
    sample = selected[0] if selected else None
    payload_sample = {}
    if sample is not None:
        digest = build_payload(sample, version=version, ingested_at="<run-time>")
        payload_sample = {
            "id": sample.point_id,
            "doc_id": digest["doc_id"],
            "chunk_id": digest["chunk_id"],
            "version": digest["version"],
            "scene": digest["scene"],
            "dept": digest["dept"] or "(未标注)",
            "permission": digest["permission"],
            "content_len": digest["content_len"],
            "content_hash": digest["content_hash"],
            "preview": preview(digest["content"]),
        }
    return {
        "input": source_label,
        "version": version,
        "collection": collection,
        "docs": len({c.doc_id for c in selected}),
        "chunks": len(selected),
        "batches": (len(selected) + batch_size - 1) // batch_size if selected else 0,
        "limit": limit or None,
        "sample": payload_sample,
    }


def print_plan(report: dict) -> None:
    print("=== RAG 入库计划（dry-run，未写库）===")
    print(f"input        : {report['input']}")
    print(f"version      : {report['version']}")
    print(f"collection   : {report['collection']}")
    print(f"docs         : {report['docs']}")
    print(f"chunks       : {report['chunks']}")
    print(f"would_upsert : {report['chunks']} 点 / {report['batches']} 批"
          f"{'（limit=' + str(report['limit']) + '）' if report['limit'] else ''}")
    sample = report.get("sample") or {}
    if sample:
        print("sample point :")
        print(f"  id={sample['id']}")
        print(f"  doc_id={sample['doc_id']} chunk_id={sample['chunk_id']} version={sample['version']}")
        print(f"  scene={sample['scene']} dept={sample['dept']} permission={sample['permission']}")
        print(f"  content_len={sample['content_len']} content_hash={sample['content_hash']}")
        print(f"  preview={sample['preview']}   # 仅 {PREVIEW_CHARS} 字预览，日志不落全文")
    print("提示          : 加 --apply 才会写入；非本机 Qdrant 还需 --allow-remote")


def _is_local(url: str) -> bool:
    from urllib.parse import urlparse

    host = (urlparse(url).hostname or "").lower()
    return host in LOCAL_HOSTS


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="科普内容 → Qdrant 入库（幂等，默认 dry-run）")
    # 注意：这里**不能** required=True —— 回滚模式（--delete-version）不需要输入源，
    # 若必填会让 argparse 在解析阶段就报错退出（exit=2），回滚路径直接不可用。
    src = parser.add_mutually_exclusive_group(required=False)
    src.add_argument("--from-kb", metavar="JS", help="前端 knowledge-kb.js 路径（用 node 读取）")
    src.add_argument("--input", metavar="JSON", help="已切好的 JSON：数组或 {articles:[...]}")
    parser.add_argument("--version", default=f"kb-{datetime.now().strftime('%Y%m%d')}",
                        help="知识版本号（进 payload，回滚按它删）")
    parser.add_argument("--source-label", default="knowledge-kb.js", help="文章无 source 时的来源标注")
    parser.add_argument("--collection", default=os.environ.get("AI_QDRANT_COLLECTION", "health_kb"))
    parser.add_argument("--qdrant-url", default=os.environ.get("AI_QDRANT_URL", "http://127.0.0.1:6333"))
    parser.add_argument("--qdrant-api-key", default=os.environ.get("AI_QDRANT_API_KEY", ""))
    parser.add_argument("--ollama-url", default=os.environ.get("AI_OLLAMA_URL", "http://127.0.0.1:11434"))
    parser.add_argument("--embedding-model", default=os.environ.get("AI_EMBEDDING_MODEL", "nomic-embed-text"))
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS, help="单片段最大字符数")
    parser.add_argument("--batch-size", type=int, default=DEFAULT_BATCH_SIZE)
    parser.add_argument("--max-retries", type=int, default=DEFAULT_MAX_RETRIES)
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个片段（0=全部）")
    parser.add_argument("--dry-run", action="store_true", help="只打印计划（默认即此行为）")
    parser.add_argument("--apply", action="store_true", help="真正写入 Qdrant")
    parser.add_argument("--allow-remote", action="store_true", help="允许写非本机 Qdrant（防止误写生产）")
    parser.add_argument("--no-purge-stale", action="store_true", help="不删除同 doc 的旧版本残留")
    parser.add_argument("--delete-version", metavar="V", help="回滚：删除该 version 的全部点")
    parser.add_argument("--delete-doc", metavar="D", help="配合 --delete-version：只删该 doc")
    parser.add_argument("--json", action="store_true", help="机器可读输出")
    args = parser.parse_args(argv)

    if args.apply and not _is_local(args.qdrant_url) and not args.allow_remote:
        print(f"[拒绝] Qdrant 非本机（{args.qdrant_url.split('//')[-1].split('/')[0]}）："
              f"确认要写远端请显式加 --allow-remote", file=sys.stderr)
        return 2

    if args.delete_version:
        if not args.apply:
            print(f"[dry-run] 将删除 version={args.delete_version}"
                  f"{'（doc=' + args.delete_doc + '）' if args.delete_doc else ''}；加 --apply 执行")
            return 0
        must = [{"key": "version", "match": {"value": args.delete_version}}]
        if args.delete_doc:
            must.append({"key": "doc_id", "match": {"value": args.delete_doc}})
        qdrant = QdrantHttp(args.qdrant_url, args.collection, api_key=args.qdrant_api_key)
        try:
            qdrant.delete_by_filter(must)
        except Exception as exc:
            print(f"[FAIL] 删除失败：{exc.__class__.__name__}（未打印地址细节）", file=sys.stderr)
            return 1
        print(f"[OK] 已按 version={args.delete_version} 删除"
              f"{'（doc=' + args.delete_doc + '）' if args.delete_doc else ''}")
        return 0

    if not (args.from_kb or args.input):
        print("[FAIL] 缺少输入源：请加 --from-kb <JS> 或 --input <JSON>", file=sys.stderr)
        return 2

    source_path = Path(args.from_kb or args.input)
    if not source_path.exists():
        print(f"[FAIL] 输入不存在：{source_path}", file=sys.stderr)
        return 2
    articles = (load_articles_from_kb(source_path) if args.from_kb
                else load_articles_from_json(source_path))
    if not articles:
        print("[FAIL] 输入未解析出任何文章", file=sys.stderr)
        return 2

    chunks: list[Chunk] = []
    for article in articles:
        chunks.extend(build_chunks(article, max_chars=args.max_chars,
                                   source_label=args.source_label))
    if args.limit and args.limit > 0:
        chunks = chunks[:args.limit]

    report = plan_report(chunks, version=args.version, collection=args.collection,
                         batch_size=args.batch_size, limit=args.limit,
                         source_label=str(source_path))
    if not args.apply:
        if args.json:
            print(json.dumps(report, ensure_ascii=False, indent=2))
        else:
            print_plan(report)
        return 0

    print(f"=== RAG 入库（apply）| docs={report['docs']} chunks={report['chunks']} "
          f"batch={args.batch_size} version={args.version} collection={args.collection} ===")
    qdrant = QdrantHttp(args.qdrant_url, args.collection, api_key=args.qdrant_api_key)
    stats = ingest(
        chunks,
        qdrant=qdrant,
        embed=lambda text: embed_text(ollama_url=args.ollama_url, model=args.embedding_model, text=text),
        version=args.version,
        batch_size=args.batch_size,
        max_retries=args.max_retries,
        purge_stale=not args.no_purge_stale,
    )
    result = stats.as_dict()
    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(f"[完成] upserted={stats.upserted} batches={stats.batches} "
              f"retries={stats.retries} failed={len(stats.failed)}")
        for item in stats.failed:
            print(f"  [FAIL] {item}")
        print("提示：重复运行不会新增重复向量（point id 由 doc_id+chunk_id 决定）")
    return 0 if not stats.failed else 1


if __name__ == "__main__":
    sys.exit(main())
