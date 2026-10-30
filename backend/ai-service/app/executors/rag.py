"""RAG 执行器：向量检索 + Embedding（M3 · 特征开关 RAG_ENABLED）。

输入（任务字段）：
- `inputInline`：用户查询文本（业务侧传入）。

输出（result）：
    {
      "documents": [
        {
          "documentId": "kb_001",
          "chunkId": "kb_001_p1",
          "content": "检索到的文本片段",
          "score": 0.85,
          "metadata": {"title": "...", "source": "...", "publishedAt": "..."}
        },
        ...
      ],
      "query": "用户查询文本",
      "provenance": "RAG_RETRIEVED"
    }

红线：
- Qdrant 不可用 → 降级为空结果（不阻断回答），不抛异常。
- 检索失败 → 降级为空结果，不编造引用。
- 日志脱敏：不打印患者原始查询文本（只记录 task ID + 结果数）。
"""

from __future__ import annotations

import json
import logging
import math
from typing import Optional

import httpx
import redis

from ..config import Settings
from ..http_client import ollama_client
from ..tasks import TaskContext, TaskFailure
from ._llm import require_input_text, trim

logger = logging.getLogger("ai-service.executors.rag")

PROMPT_TEMPLATE_VERSION = "rag-retrieval-v1"


async def _get_embedding(
    settings: Settings,
    text: str,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> Optional[list[float]]:
    """调用 Ollama embedding 模型，返回向量；失败返回 None（不抛异常）。

    连接复用（2026-10-22）：embedding 走 Ollama 主链路，复用 http_client.ollama_client
    全局连接池（与 LLM 生成共享）；transport 注入（测试）时退化为一次性 client。
    """
    try:
        async with ollama_client(settings, transport=transport) as client:
            resp = await client.post(
                settings.ollama_url.rstrip("/") + "/api/embeddings",
                json={"model": settings.embedding_model, "prompt": text},
            )
            resp.raise_for_status()
            embedding = resp.json().get("embedding")
            if embedding and isinstance(embedding, list):
                return embedding
            return None
    except Exception as exc:
        logger.warning("Embedding 生成失败 | model=%s | error=%s", settings.embedding_model, exc.__class__.__name__)
        return None


async def _search_qdrant(
    qdrant_url: str,
    collection: str,
    vector: list[float],
    top_k: int,
    score_threshold: float,
    timeout: float,
    api_key: str = "",
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> Optional[list[dict]]:
    """调用 Qdrant 检索，返回结果列表；失败返回 None（不抛异常）。"""
    try:
        headers = {}
        if api_key:
            headers["api-key"] = api_key
        
        client_kwargs = {"timeout": timeout, "trust_env": False, "headers": headers}
        if transport is not None:
            client_kwargs["transport"] = transport
        
        async with httpx.AsyncClient(**client_kwargs) as client:
            resp = await client.post(
                f"{qdrant_url.rstrip('/')}/collections/{collection}/points/search",
                json={
                    "vector": vector,
                    "limit": top_k,
                    "score_threshold": score_threshold,
                    "with_payload": True,
                    "with_vector": False,
                }
            )
            resp.raise_for_status()
            result = resp.json().get("result", [])
            if isinstance(result, list):
                return result
            return None
    except Exception as exc:
        logger.warning("Qdrant 检索失败 | collection=%s | error=%s", collection, exc.__class__.__name__)
        return None


def _cosine(a: list[float], b: list[float]) -> float:
    """纯 Python 余弦相似度（演示用，避免引入 numpy 依赖；768 维 × 数百条 < 1s）。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 0.0 or nb <= 0.0:
        return 0.0
    return dot / (math.sqrt(na) * math.sqrt(nb))


async def _search_redis(
    redis_url: str,
    key_prefix: str,
    vector: list[float],
    top_k: int,
    score_threshold: float,
    timeout: float,
) -> Optional[list[dict]]:
    """Redis 演示版向量检索（V23，2026-10-24）。

    结构（tools/rag_redis_seed.py 入库）：
      - SET  {prefix}index            → 全部 chunkId（SADD，检索入口）；
      - STR  {prefix}vec:{chunkId}    → JSON {vector, documentId, chunkId, content,
                                           title, source, publishedAt}。
    检索：SMEMBERS → 逐条取回 → 服务端余弦 → 阈值过滤 → top-k（按 score 降序）。
    边界：连接失败 / 索引不存在 → None（调用方按 RAG_RETRIEVAL_FAILED 降级，不阻断回答）；
          索引存在但无命中 → []（RAG_NO_RESULTS）。与 Qdrant 分支的失败语义保持一致。
    """
    try:
        client = redis.Redis.from_url(
            redis_url,
            socket_connect_timeout=timeout,
            socket_timeout=timeout,
            decode_responses=True,
            protocol=2,  # Redis 3.x 无 RESP3/HELLO
        )
        try:
            chunk_ids = client.smembers(key_prefix + "index")
        except redis.ResponseError:
            logger.warning("Redis RAG 索引不存在（先跑 tools/rag_redis_seed.py）| prefix=%s", key_prefix)
            return []
        hits: list[dict] = []
        if chunk_ids:
            pipe = client.pipeline(transaction=False)
            for cid in chunk_ids:
                pipe.get(key_prefix + "vec:" + cid)
            raw_items = pipe.execute()
            for cid, raw in zip(chunk_ids, raw_items):
                if not raw:
                    continue
                try:
                    doc = json.loads(raw)
                except (TypeError, ValueError):
                    continue
                emb = doc.get("vector")
                if not isinstance(emb, list):
                    continue
                score = _cosine(vector, emb)
                if score < score_threshold:
                    continue
                hits.append({
                    "id": doc.get("chunkId") or cid,
                    "score": round(score, 3),
                    "payload": {
                        "documentId": doc.get("documentId"),
                        "chunkId": doc.get("chunkId"),
                        "content": doc.get("content"),
                        "title": doc.get("title"),
                        "source": doc.get("source"),
                        "publishedAt": doc.get("publishedAt"),
                    },
                })
        client.close()
        hits.sort(key=lambda h: h["score"], reverse=True)
        return hits[:top_k]
    except Exception as exc:
        logger.warning("Redis RAG 检索失败 | error=%s", exc.__class__.__name__)
        return None


def build_rag_executor(
    settings: Settings,
    probe,
    transport: Optional[httpx.AsyncBaseTransport] = None,
):
    """构造 RAG 执行器。transport 仅测试注入（httpx.MockTransport），生产为 None。"""

    async def executor(task: dict, ctx: TaskContext) -> dict:
        query = require_input_text(task)
        
        # ---- 特征开关：RAG 关闭 → 快速失败 ----
        if not settings.rag_enabled:
            raise TaskFailure(
                "CAPABILITY_UNAVAILABLE",
                "RAG 检索未启用（AI_RAG_ENABLED=false）",
                dependency="qdrant",
                retryable=False,
            )
        
        # ---- 阶段 1：生成 query embedding（带重试） ----
        # ⚠️ phase 只能用契约枚举（ai-openapi: queued/safety_check/retrieval/generation/postprocess/synthesis）；
        # 早先这里写 "embedding" → TaskContext 抛 ValueError("非法阶段名") → 独立 RAG 任务 100% FAILED。
        # embedding 属于检索阶段的一部分，统一报 retrieval（2026-10-22 修复）。
        await ctx.set_phase("retrieval")
        embedding = None
        for attempt in range(settings.rag_max_retries + 1):
            embedding = await _get_embedding(settings, query, transport=transport)
            if embedding is not None:
                break
            if attempt < settings.rag_max_retries:
                logger.info("Embedding 生成失败，重试 %d/%d | task=%s", attempt + 1, settings.rag_max_retries, task.get("taskId"))
        
        if embedding is None:
            # 降级为空结果（不阻断回答）
            logger.warning("Embedding 生成失败（已重试 %d 次），降级为空结果 | task=%s", settings.rag_max_retries, task.get("taskId"))
            return {
                "result": {
                    "documents": [],
                    "query": query,
                    "provenance": "RAG_RETRIEVAL_FAILED",
                },
                "model": {
                    "modelId": settings.embedding_model,
                    "modelProfile": None,
                    "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                    "cached": False,
                },
            }
        
        # ---- 阶段 2：向量检索（rag_store=redis 演示 / qdrant 生产，带重试）----
        # 阶段名沿用在上面的 retrieval（契约无更细粒度枚举），此处不再重复 set_phase
        search_result = None
        for attempt in range(settings.rag_max_retries + 1):
            if (settings.rag_store or "redis").lower() == "redis":
                search_result = await _search_redis(
                    settings.redis_url,
                    settings.redis_key_prefix,
                    embedding,
                    settings.rag_top_k,
                    settings.rag_score_threshold,
                    settings.redis_timeout_seconds,
                )
            else:
                search_result = await _search_qdrant(
                    settings.qdrant_url,
                    settings.qdrant_collection,
                    embedding,
                    settings.rag_top_k,
                    settings.rag_score_threshold,
                    settings.qdrant_timeout_seconds,
                    settings.qdrant_api_key,
                    transport,
                )
            if search_result is not None:
                break
            if attempt < settings.rag_max_retries:
                logger.info("RAG 检索失败，重试 %d/%d | task=%s", attempt + 1, settings.rag_max_retries, task.get("taskId"))
        
        if search_result is None:
            # 降级为空结果（不阻断回答）
            logger.warning("Qdrant 检索失败（已重试 %d 次），降级为空结果 | task=%s", settings.rag_max_retries, task.get("taskId"))
            return {
                "result": {
                    "documents": [],
                    "query": query,
                    "provenance": "RAG_RETRIEVAL_FAILED",
                },
                "model": {
                    "modelId": settings.embedding_model,
                    "modelProfile": None,
                    "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                    "cached": False,
                },
            }
        
        # ---- 阶段 3：结果转换与脱敏 ----
        documents = []
        for hit in search_result:
            score = hit.get("score", 0.0)
            payload = hit.get("payload", {})
            
            # 提取文档元数据（脱敏：不打印患者数据）
            doc = {
                "documentId": str(payload.get("documentId") or payload.get("document_id") or "unknown"),
                "chunkId": str(payload.get("chunkId") or payload.get("chunk_id") or "unknown"),
                "content": trim(payload.get("content") or payload.get("text") or "", 500),
                "score": round(score, 3),
                "metadata": {
                    "title": trim(payload.get("title"), 100),
                    "source": trim(payload.get("source"), 100),
                    "publishedAt": trim(payload.get("publishedAt") or payload.get("published_at"), 50),
                },
            }
            documents.append(doc)
        
        # 日志脱敏：只记录 task ID + 结果数 + 最高分，不打印查询原文
        logger.info(
            "RAG 检索完成 | task=%s | results=%d | topScore=%.3f",
            task.get("taskId"),
            len(documents),
            documents[0]["score"] if documents else 0.0,
        )
        
        return {
            "result": {
                "documents": documents,
                "query": query,
                "provenance": "RAG_RETRIEVED" if documents else "RAG_NO_RESULTS",
            },
            "model": {
                "modelId": settings.embedding_model,
                "modelProfile": None,
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                "cached": False,
            },
        }
    
    return executor
