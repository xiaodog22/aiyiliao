"""能力探测与就绪状态（对齐 ReadinessResult）。

原则（docs/v4/04 §12）：
- 依赖不可用 → 状态是 `unavailable`，不是"服务挂了"；服务照常接收请求。
- 探针不返回模型绝对路径、内网地址、凭据或队列中任务内容。
- `degraded` 时编排器不得重启实例。
"""

from __future__ import annotations

import time
from typing import Callable, Optional

import httpx

from .config import Settings
from .voice import asr_status, tts_status

_PROBE_TTL_SECONDS = 5.0


async def fetch_ollama_tags(url: str, timeout: float) -> Optional[list[str]]:
    """返回已安装模型名列表；不可达返回 None（不抛异常）。"""
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.get(url.rstrip("/") + "/api/tags")
            resp.raise_for_status()
            models = resp.json().get("models") or []
            return [m.get("name", "") for m in models if m.get("name")]
    except Exception:
        return None


async def probe_qdrant(url: str, timeout: float) -> tuple[bool, Optional[str]]:
    """探测 Qdrant 可达性。返回 (可达, 详情)；不可达返回 (False, 错误原因)。"""
    try:
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.get(url.rstrip("/") + "/")
            resp.raise_for_status()
            return True, None
    except httpx.TimeoutException:
        return False, "超时"
    except httpx.HTTPStatusError as exc:
        return False, f"HTTP {exc.response.status_code}"
    except Exception as exc:
        return False, exc.__class__.__name__


def probe_redis(redis_url: str, key_prefix: str, timeout: float) -> tuple[bool, Optional[str]]:
    """探测 Redis 可达性与 RAG 索引存在（V23 演示版）。返回 (可达, 详情)；不可达返回 (False, 原因)。"""
    try:
        import redis as redis_mod

        client = redis_mod.Redis.from_url(
            redis_url, socket_connect_timeout=timeout, socket_timeout=timeout, decode_responses=True,
            protocol=2,  # Redis 3.x 无 RESP3/HELLO
        )
        try:
            client.ping()
            indexed = client.exists(key_prefix + "index") > 0
            detail = "已连通，索引在位" if indexed else "已连通，索引未入库（先跑 tools/rag_redis_seed.py）"
            return True, detail
        finally:
            client.close()
    except Exception as exc:
        return False, exc.__class__.__name__


class CapabilityProbe:
    """就绪探针：探测结果带短 TTL 缓存，避免探活放大成对下游的持续压力。"""

    def __init__(self, settings: Settings, ollama_probe: Optional[Callable] = None) -> None:
        self.settings = settings
        self._ollama_probe = ollama_probe or fetch_ollama_tags
        self._cached_at: float = 0.0
        self._cached_tags: Optional[list[str]] = None

    async def ollama_tags(self) -> Optional[list[str]]:
        now = time.monotonic()
        if now - self._cached_at < _PROBE_TTL_SECONDS:
            return self._cached_tags
        tags = await self._ollama_probe(self.settings.ollama_url, self.settings.probe_timeout_seconds)
        self._cached_at = time.monotonic()
        self._cached_tags = tags
        return tags

    async def readiness(self) -> dict:
        s = self.settings
        tags = await self.ollama_tags()
        ollama_ok = tags is not None
        small_present = ollama_ok and s.small_model in (tags or [])
        large_present = ollama_ok and s.large_model in (tags or [])

        if ollama_ok and small_present:
            ollama_status, ollama_detail = "available", "已连通，默认小模型在位"
        elif ollama_ok:
            ollama_status, ollama_detail = "degraded", f"已连通，但未找到模型 {s.small_model}"
        else:
            ollama_status, ollama_detail = "unavailable", "未连通（本机模型服务未启动或地址未配置）"

        asr_state, asr_detail = asr_status(s)
        tts_state, tts_detail = tts_status(s)

        # ---- RAG 依赖探测（特征开关控制，2026-10-22；V23 支持 redis 演示后端）----
        rag_store = (s.rag_store or "redis").lower() if s.rag_enabled else "qdrant"
        # Embedding 模型探测（依赖 Ollama；两个 RAG 分支共用）
        embedding_present = ollama_ok and s.embedding_model in (tags or [])
        if embedding_present:
            embedding_status = "loaded"
            embedding_model_id = s.embedding_model
        else:
            embedding_status = "not_loaded" if ollama_ok else "unavailable"
            embedding_model_id = None

        if s.rag_enabled and rag_store == "redis":
            redis_ok, redis_err = probe_redis(s.redis_url, s.redis_key_prefix, s.probe_timeout_seconds)
            if redis_ok:
                redis_status, redis_detail = "available", redis_err or "已连通"
                vector_status, vector_detail = "available", "Redis 演示向量存储已连通"
            else:
                redis_status, redis_detail = "unavailable", f"未连通（{redis_err}）"
                vector_status, vector_detail = "unavailable", f"未连通（{redis_err}）"
            qdrant_status, qdrant_detail = "unavailable", "未启用（rag_store=redis）"
        elif s.rag_enabled:
            redis_status, redis_detail = "unavailable", "未启用（rag_store=qdrant）"
            vector_status, vector_detail = "unavailable", "未启用（rag_store=qdrant）"
            qdrant_ok, qdrant_err = await probe_qdrant(s.qdrant_url, s.probe_timeout_seconds)
            if qdrant_ok:
                qdrant_status, qdrant_detail = "available", "已连通"
                vector_status, vector_detail = "available", "Qdrant 向量库已连通"
            else:
                qdrant_status, qdrant_detail = "unavailable", f"未连通（{qdrant_err}）"
                vector_status, vector_detail = "unavailable", f"未连通（{qdrant_err}）"
        else:
            redis_status, redis_detail = "unavailable", "未启用（AI_RAG_ENABLED=false）"
            vector_status, vector_detail = "unavailable", "未启用（AI_RAG_ENABLED=false）"
            qdrant_status, qdrant_detail = "unavailable", "未启用（AI_RAG_ENABLED=false）"
            embedding_status = "unavailable"
            embedding_model_id = None

        dependencies = [
            {"name": "ollama", "status": ollama_status, "detail": ollama_detail, "latencyMs": None},
            {"name": "redis", "status": redis_status, "detail": redis_detail, "latencyMs": None},
            {"name": "qdrant", "status": qdrant_status, "detail": qdrant_detail, "latencyMs": None},
            {"name": "vector_store", "status": vector_status, "detail": vector_detail, "latencyMs": None},
            {"name": "asr_model", "status": asr_state, "detail": asr_detail, "latencyMs": None},
            {"name": "tts_provider", "status": tts_state, "detail": tts_detail, "latencyMs": None},
        ]

        models = [
            {
                "role": "small-default",
                "modelId": s.small_model if small_present else None,
                "status": "loaded" if small_present else ("unavailable" if not ollama_ok else "not_loaded"),
                "resident": None,
            },
            {
                "role": "large-upgrade",
                "modelId": s.large_model if large_present else None,
                "status": "not_loaded" if large_present else "unavailable",
                "resident": None,
            },
            {"role": "asr",
             "modelId": (s.asr_engine or "none").lower() if asr_state == "available" else None,
             "status": "loaded" if asr_state == "available" else "unavailable",
             "resident": None},
            {"role": "embedding", "modelId": embedding_model_id, "status": embedding_status, "resident": None},
        ]

        core_states = [ollama_status, asr_state, tts_state]  # ollama / asr_model / tts_provider
        available_count = sum(1 for st in core_states if st == "available")
        if available_count == len(core_states):
            overall = "ok"
        elif available_count == 0:
            overall = "down"
        else:
            overall = "degraded"

        return {"status": overall, "dependencies": dependencies, "models": models}
