"""进程级 httpx 单例（LLM / Ollama 调用复用）。

设计目标（2026-10-22 性能优化）：
- **复用**：同一 `httpx.AsyncClient` 跨多次 Ollama 调用复用，连接池复用已建立的 TCP 连接，
  降低每次握手开销；多 worker 并发也共用这一个 client（httpx client 本身协程安全）。
- **可配**：连接池上限、keepalive、整体超时、连接级重试均来自 `Settings`，可经环境变量调整。
- **可降级**：`Settings.llm_http_client_reuse=False` 时本模块返回 `None`，调用方回落为
  「每次调用新建一次性 client 并关闭」（即优化前的旧行为）。这是回滚开关之一。
- **可释放**：`close_client()` 在应用关闭时 `await`，释放连接池；测试用 `reset_client()`。
- **连接池即背压**：`max_connections` 限制对 Ollama 的并发连接数，配合任务队列 `maxsize`，
  避免突发流量打爆本机 Ollama。

红线：不在本文件落任何凭据；单例仅在主事件循环内创建与释放。
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

import httpx

from .config import Settings

logger = logging.getLogger("ai-service.http")

_client: Optional[httpx.AsyncClient] = None


def _build(settings: Settings) -> httpx.AsyncClient:
    """构造一个带连接池 / 超时 / 连接级重试的 client。"""
    limits = httpx.Limits(
        max_connections=settings.llm_http_pool_max_connections,
        max_keepalive_connections=settings.llm_http_pool_keepalive,
    )
    timeout = httpx.Timeout(settings.llm_http_timeout_seconds, connect=settings.probe_timeout_seconds)
    transport = httpx.AsyncHTTPTransport(retries=settings.llm_http_max_retries, limits=limits)
    return httpx.AsyncClient(timeout=timeout, transport=transport, trust_env=False)


def get_client(settings: Settings) -> Optional[httpx.AsyncClient]:
    """返回可复用的全局 client；若 reuse 关闭返回 None（调用方自建一次性 client）。"""
    global _client
    if not settings.llm_http_client_reuse:
        return None
    if _client is None:
        _client = _build(settings)
        logger.info(
            "LLM httpx 复用 client 已创建 | max_conns=%d keepalive=%d retries=%d",
            settings.llm_http_pool_max_connections,
            settings.llm_http_pool_keepalive,
            settings.llm_http_max_retries,
        )
    return _client


@asynccontextmanager
async def ollama_client(settings: Settings, *, transport=None) -> AsyncIterator[httpx.AsyncClient]:
    """产出用于一次 Ollama 调用的 httpx client，并保证正确释放。

    - transport 注入（测试）：一次性 client，使用注入的 transport，退出时关闭。
    - reuse 开启：返回全局单例（不关闭，由 close_client 在关闭时统一释放）。
    - reuse 关闭：一次性 client（完全回到优化前行为），退出时关闭。
    """
    if transport is not None:
        client = httpx.AsyncClient(
            timeout=httpx.Timeout(settings.llm_http_timeout_seconds, connect=settings.probe_timeout_seconds),
            transport=transport,
            trust_env=False,
        )
        try:
            yield client
        finally:
            await client.aclose()
        return

    shared = get_client(settings)
    if shared is not None:
        yield shared
        return

    # 回滚路径：每次新建，用完即关（旧行为）
    client = httpx.AsyncClient(
        timeout=httpx.Timeout(settings.llm_http_timeout_seconds, connect=settings.probe_timeout_seconds),
        trust_env=False,
    )
    try:
        yield client
    finally:
        await client.aclose()


async def close_http_client() -> None:
    """应用关闭时释放全局复用 client（必须在事件循环内 await）。"""
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None
        logger.info("LLM httpx 复用 client 已关闭")


def reset_client() -> None:
    """测试隔离：同步丢弃单例（不 await）。下一次调用在所属事件循环内重建。"""
    global _client
    _client = None
