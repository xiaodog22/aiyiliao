"""LLM 层轻量运行指标（仅内部可观测，不影响响应契约）。

采集：
- 流式首 token 延迟样本（ms）：用于压测与在线观察「时间到首 token」。
- 流式成功 / 流式失败回退次数：验证流式降级是否触发。

线程安全：指标在 asyncio 单线程内更新，但测试可能在多线程/事件循环边界读取，
故用 `threading.Lock` 保护（开销可忽略）。

红线：指标只计数与采样，绝不包含任何请求正文 / 用户数据 / 凭据。
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import List


@dataclass
class LLMMetrics:
    _lock: threading.Lock = field(default_factory=threading.Lock)
    first_token_ms: List[float] = field(default_factory=list)
    stream_ok: int = 0
    stream_fallback: int = 0
    last_fallback_error: str = ""

    def record_first_token(self, ms: float) -> None:
        with self._lock:
            samples = self.first_token_ms
            samples.append(ms)
            if len(samples) > 2000:  # 滑动窗口，避免无限增长
                samples.pop(0)

    def record_stream_ok(self) -> None:
        with self._lock:
            self.stream_ok += 1

    def record_stream_fallback(self, error: str = "") -> None:
        with self._lock:
            self.stream_fallback += 1
            self.last_fallback_error = error

    def snapshot(self) -> dict:
        with self._lock:
            samples = list(self.first_token_ms)
            n = len(samples)
            if n:
                s = sorted(samples)
                avg = sum(s) / n
                p50 = s[n // 2]
                p95 = s[min(n - 1, int(n * 0.95))]
            else:
                avg = p50 = p95 = None
            return {
                "firstTokenSamples": n,
                "firstTokenAvgMs": round(avg, 1) if avg is not None else None,
                "firstTokenP50Ms": round(p50, 1) if p50 is not None else None,
                "firstTokenP95Ms": round(p95, 1) if p95 is not None else None,
                "streamOk": self.stream_ok,
                "streamFallback": self.stream_fallback,
                "lastFallbackError": self.last_fallback_error,
            }


_metrics = LLMMetrics()


def metrics() -> LLMMetrics:
    return _metrics


def reset_metrics() -> None:
    """测试隔离：清空所有计数与样本。"""
    global _metrics
    _metrics = LLMMetrics()
