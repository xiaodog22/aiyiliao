"""网关限流（M4 硬化项提前到 M3 · D 侧）。

定位：**保护上游**（business/ai）不被单一客户端突发流量打穿，而非做配额计费。
因此实现刻意保持轻量、无外部依赖、单进程内存态（网关为单实例边缘服务）：

- 固定窗口计数（per 客户端标识 + 路径分组），窗口默认 60s；
- 窗口到期即重置，不需要持久化（重启丢计数 = 放宽一次，可接受）；
- 桶表按需惰性清理，避免长跑内存增长；
- 探针路径（/health、/api/gw/health）不参与限流——否则编排器的健康轮询会被自己限死。

命中限流 → 429 + 统一错误信封（code=RATE_LIMITED，retryable=true）+ `Retry-After` 秒数。
默认**关闭**（GW_RATE_LIMIT_ENABLED），deploy 显式开启；dev/测试不受影响。
"""

from __future__ import annotations

import time
from dataclasses import dataclass


@dataclass(frozen=True)
class LimitDecision:
    allowed: bool
    remaining: int
    retry_after: int  # 秒；allowed=True 时为 0


class FixedWindowLimiter:
    """固定窗口限流器（纯内存；单进程）。

    线程/协程安全说明：网关是单事件循环 asyncio 应用，`check` 为纯同步计算、
    无 await 中断点，天然原子，无需加锁。
    """

    def __init__(self, limit: int, window_seconds: int, *, max_keys: int = 20000) -> None:
        self.limit = max(1, int(limit))
        self.window_seconds = max(1, int(window_seconds))
        self.max_keys = max(1, int(max_keys))
        self._buckets: dict[str, tuple[int, int]] = {}  # key -> (window_start_epoch_s, count)

    def _window_start(self, now: float) -> int:
        return int(now // self.window_seconds) * self.window_seconds

    def check(self, key: str, now: float | None = None) -> LimitDecision:
        ts = time.time() if now is None else now
        start = self._window_start(ts)
        current = self._buckets.get(key)
        if current is None or current[0] != start:
            count = 1
            self._buckets[key] = (start, count)
            if len(self._buckets) > self.max_keys:
                self._evict(ts)
            return LimitDecision(True, max(0, self.limit - count), 0)
        count = current[1] + 1
        self._buckets[key] = (start, count)
        if count > self.limit:
            retry_after = max(1, start + self.window_seconds - int(ts))
            return LimitDecision(False, 0, retry_after)
        return LimitDecision(True, max(0, self.limit - count), 0)

    def _evict(self, now: float) -> None:
        """惰性清理：丢弃已过期的桶（当前窗口之外的都无效）。"""
        start = self._window_start(now)
        stale = [k for k, v in self._buckets.items() if v[0] != start]
        for k in stale:
            self._buckets.pop(k, None)
        # 极端情况下（同一窗口内 key 数超限）兜底清空，宁可放宽也不无限增长。
        if len(self._buckets) > self.max_keys:
            self._buckets.clear()

    def stats(self) -> dict:
        return {"trackedKeys": len(self._buckets), "limit": self.limit, "windowSeconds": self.window_seconds}


# 不参与限流的路径（探针与网关自身健康）；其余 /api/** 与 /health 之外的入口都计入。
EXEMPT_PATHS = {"/health", "/api/gw/health"}


def client_key(headers: dict, client_host: str | None) -> str:
    """客户端标识：优先 X-Forwarded-For 首跳（隧道/反代场景），否则回落到直连地址。

    ⚠️ XFF 可被伪造——本限流是**粗粒度保护**，不承担鉴权职责；真实配额须在鉴权后按用户维度做。
    """
    xff = ""
    for key, value in headers.items():
        if key.lower() == "x-forwarded-for":
            xff = value or ""
            break
    if xff:
        first = xff.split(",")[0].strip()
        if first:
            return first
    return client_host or "unknown"
