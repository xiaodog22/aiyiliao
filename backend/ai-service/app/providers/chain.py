"""Provider 链（B2 三步走）：Ollama → DeepSeek → 兜底。

为什么收口在这里：
  `triage.py` 原先**直调** `_llm._post_ollama_generate`，不经过 `generate_text` —— 链若建在
  `generate_text` 层，导诊永远只有 Ollama 一级。现在所有执行器都调 `chain.generate`，
  triage 与 chat/careplan/interpret 走同一条链。

第三级不是 Python 规则引擎：
  triage 的第三级由 **business `TriageRuleEngine`** 承担（单一事实源，避免第三份科室词表漂移）。
  ai-service 在三级耗尽时抛 `CAPABILITY_UNAVAILABLE`，business 侧据此回退到现成规则引擎；
  chat/careplan/interpret 由 business 既有兜底路径承接。本模块不新增任何医学规则。

熔断：连续失败达阈值 → 冷却期内直接跳过该级（不再白等）；冷却结束半开试探一次，
成功即恢复。熔断状态是**进程内**的，多副本各自独立（符合"本机 Ollama 可随时关机"的定位）。
"""

from __future__ import annotations

import logging
import time
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Optional

import httpx

from ..config import Settings
from ..metrics import metrics
from ..tasks import TaskFailure
from . import deepseek as deepseek_provider
from . import ollama as ollama_provider

logger = logging.getLogger("ai-service.providers.chain")

# 当前正在使用（或最后尝试）的 provider，供执行器做 dependency 归因（O-10：不撒谎）。
_current_provider: ContextVar[str] = ContextVar("llm_provider", default="ollama")


@dataclass
class ChainResult:
    text: str
    model: str
    source: str  # ollama | deepseek | rule（本模块只会产出前两者）
    stream_fallback_reason: str = ""  # 非空 = 第一级流式不可用、已回退非流式


def current_provider() -> str:
    """当前 provider 名（供 `dependency=` 与 `llmSource` 使用）。"""
    return _current_provider.get()


def provider_order(settings: Settings) -> list[str]:
    """解析 `AI_PROVIDER_ORDER`（默认 ollama,deepseek）；`rule` 由 business 侧承载，此处忽略。"""
    raw = str(settings.provider_order or "ollama,deepseek")
    names = [p.strip().lower() for p in raw.split(",") if p.strip()]
    return [p for p in names if p in ("ollama", "deepseek")]


def has_fallback(settings: Settings) -> bool:
    """是否存在可用的第二级（DeepSeek 已配置 key）。用于决定 Ollama 就位性检查是否必须硬失败。"""
    return "deepseek" in provider_order(settings) and bool(settings.deepseek_api_key)


class _Breaker:
    """极简熔断器：连续失败 N 次 → 冷却期内跳过，到期半开一次试探。"""

    def __init__(self) -> None:
        self.failures = 0
        self.open_until = 0.0

    def allow(self) -> bool:
        return time.monotonic() >= self.open_until

    def record_success(self) -> None:
        self.failures = 0
        self.open_until = 0.0

    def record_failure(self, threshold: int, cooldown_s: float) -> bool:
        """返回本次是否**新开**熔断（便于日志/指标只记一次）。"""
        self.failures += 1
        if threshold > 0 and self.failures >= threshold and self.allow():
            self.open_until = time.monotonic() + max(cooldown_s, 0.0)
            self.failures = 0
            return True
        return False


_breakers: dict[str, _Breaker] = {"ollama": _Breaker(), "deepseek": _Breaker()}


def reset_breakers() -> None:
    """测试隔离：清空熔断状态。"""
    global _breakers
    _breakers = {"ollama": _Breaker(), "deepseek": _Breaker()}


def _breaker_for(name: str) -> _Breaker:
    if name not in _breakers:
        _breakers[name] = _Breaker()
    return _breakers[name]


async def generate(
    settings: Settings,
    payload: dict,
    *,
    timeout_s: float,
    first_token_timeout_s: float,
    fallback_timeout_s: Optional[float] = None,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> ChainResult:
    """按 provider 顺序尝试；逐级失败可识别上报，全部失败抛最后一个真实失败。"""
    order = provider_order(settings)
    if not order:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", "AI_PROVIDER_ORDER 未配置可用 provider",
            dependency=None, retryable=True,
        )

    last_failure: Optional[TaskFailure] = None
    attempted: list[str] = []

    for name in order:
        if name == "deepseek" and not settings.deepseek_api_key:
            # fail-fast：未配置就跳过，不发请求、不空转（评审要求）
            continue

        breaker = _breaker_for(name)
        if not breaker.allow():
            metrics().record_provider_skip(name, "breaker_open")
            logger.info("provider 熔断中，跳过 | provider=%s", name)
            continue

        attempted.append(name)
        _current_provider.set(name)

        try:
            fallback_reason = ""
            if name == "ollama":
                text, model, fallback_reason = await ollama_provider.generate(
                    settings, payload,
                    timeout_s=timeout_s,
                    first_token_timeout_s=first_token_timeout_s,
                    transport=transport,
                )
            else:
                text, model = await deepseek_provider.generate(
                    settings, payload,
                    timeout_s=fallback_timeout_s or timeout_s,
                    transport=transport,
                )
        except deepseek_provider.NotConfigured:
            continue
        except TaskFailure as exc:
            last_failure = exc
            metrics().record_provider_failure(name, exc.code)
            if breaker.record_failure(settings.breaker_failures, settings.breaker_cooldown_seconds):
                metrics().record_breaker_open(name)
                logger.warning(
                    "provider 熔断开启 | provider=%s | threshold=%d | cooldown=%.0fs",
                    name, settings.breaker_failures, settings.breaker_cooldown_seconds,
                )
            # 鉴权类失败不重试但可以降级到下一级（不是重试同一级）
            logger.warning(
                "provider 失败，尝试下一级 | provider=%s | code=%s", name, exc.code,
            )
            continue

        breaker.record_success()
        metrics().record_provider_hit(name)
        _current_provider.set(name)
        return ChainResult(
            text=text, model=model, source=name,
            stream_fallback_reason=fallback_reason if name == "ollama" else "",
        )

    # 三级耗尽：把真实失败归因原样抛出（dependency 是最后一级实际失败方，不是硬编码 ollama）
    if last_failure is not None:
        if len(attempted) > 1:
            raise TaskFailure(
                last_failure.code, last_failure.message,
                dependency=last_failure.dependency, retryable=last_failure.retryable,
            )
        raise last_failure

    raise TaskFailure(
        "CAPABILITY_UNAVAILABLE", "没有可用的模型提供方（未配置 DeepSeek key）",
        dependency=None, retryable=True,
    )
