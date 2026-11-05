"""Ollama provider：第一级（本地内网穿透的 Ollama）。

为什么这里是流式实现：
  评审要求「**首 token 超时**」而不是总时长硬超时——7B 模型生成 300 token 在 CPU 上
  远超 6~10s，若按总时长卡会在本地正常生成中被误判超时，"本地优先"名存实亡。
  只有流式才能把「多久出第一个 token」和「生成多久」分开计量。

流不稳时的兼容：若流式入口返回 4xx/5xx 或拿到空响应，**先在同一级回退一次非流式**
（老版本就是非流式，能工作的服务不该因为"只支持非流式"被判失败），仍失败才交给下一级。
回退原因由调用方（chain/_llm）记入 metrics 与 WARN 日志。

错误映射（与旧 `_post_ollama_generate` 保持一致，不新增语义）：
  - 连不上 / 连接超时 / 首 token 超时 → MODEL_TIMEOUT / CAPABILITY_UNAVAILABLE（可重试）
  - 404（模型未安装）            → CAPABILITY_UNAVAILABLE
  - 其他 4xx/5xx                → MODEL_UNAVAILABLE
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Optional

import httpx

from ..config import Settings
from ..http_client import ollama_client
from ..metrics import metrics
from ..tasks import TaskFailure

logger = logging.getLogger("ai-service.providers.ollama")

PROVIDER_NAME = "ollama"


def _generate_url(settings: Settings) -> str:
    return settings.ollama_url.rstrip("/") + "/api/generate"


async def _generate_nonstream(
    settings: Settings,
    payload: dict,
    *,
    timeout_s: float,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> tuple[str, str]:
    """非流式调用：流式不可用时的同 provider 回退路径。"""
    model = str(payload.get("model") or "")
    async with ollama_client(settings, transport=transport) as client:
        try:
            resp = await client.post(
                _generate_url(settings),
                json={**payload, "stream": False},
                timeout=httpx.Timeout(timeout_s, connect=settings.probe_timeout_seconds),
            )
        except httpx.TimeoutException:
            raise TaskFailure(
                "MODEL_TIMEOUT", f"模型响应超时（{timeout_s:.0f}s）",
                dependency=PROVIDER_NAME, retryable=True,
            )
        except httpx.HTTPError as exc:
            raise TaskFailure(
                "CAPABILITY_UNAVAILABLE", f"模型服务请求失败（{exc.__class__.__name__}）",
                dependency=PROVIDER_NAME, retryable=True,
            )
    if resp.status_code == 404:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"模型 {model} 未安装或不可用",
            dependency=PROVIDER_NAME, retryable=True,
        )
    if resp.status_code >= 400:
        raise TaskFailure(
            "MODEL_UNAVAILABLE", f"模型服务返回 HTTP {resp.status_code}",
            dependency=PROVIDER_NAME, retryable=True,
        )
    try:
        raw = resp.json()
        text = str(raw.get("response") or "")
        actual_model = str(raw.get("model") or model)
    except (ValueError, TypeError):
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "模型响应不是合法 JSON",
            dependency=PROVIDER_NAME, retryable=False,
        )
    if not text:
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "模型返回空输出",
            dependency=PROVIDER_NAME, retryable=True,
        )
    return text, actual_model


async def generate(
    settings: Settings,
    payload: dict,
    *,
    timeout_s: float,
    first_token_timeout_s: float,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    force_stream: bool = True,
) -> tuple[str, str, str]:
    """跑一次生成，返回 (全文, 实际模型名, 流式回退原因)。

    第三项为空串表示流式成功；非空表示"流式不可用，已回退非流式"，由调用方记录。
    失败一律 TaskFailure（可识别码 + provider 归因）。
    """
    if not force_stream:
        text, model = await _generate_nonstream(settings, payload, timeout_s=timeout_s, transport=transport)
        return text, model, "forced-nonstream"

    model = str(payload.get("model") or "")
    stream_payload = {**payload, "stream": True}
    buf: list[str] = []
    t0 = time.monotonic()
    deadline = t0 + timeout_s
    first_token_ms: Optional[float] = None

    async with ollama_client(settings, transport=transport) as client:
        try:
            async with client.stream(
                "POST",
                _generate_url(settings),
                json=stream_payload,
                timeout=httpx.Timeout(timeout_s, connect=settings.probe_timeout_seconds),
            ) as resp:
                if resp.status_code == 404:
                    raise TaskFailure(
                        "CAPABILITY_UNAVAILABLE", f"模型 {model} 未安装或不可用",
                        dependency=PROVIDER_NAME, retryable=True,
                    )
                if resp.status_code >= 400:
                    # 流式入口不可用 → 同 provider 回退非流式（不直接判死）
                    logger.warning("流式返回 HTTP %d，回退非流式 | model=%s", resp.status_code, model)
                    text, actual_model = await _generate_nonstream(
                        settings, payload, timeout_s=timeout_s, transport=transport
                    )
                    return text, actual_model, f"stream-http-{resp.status_code}"

                lines = resp.aiter_lines()
                while True:
                    now = time.monotonic()
                    # 第一个 token 用**独立阈值**；拿到后改用剩余总预算，避免长生成被误杀。
                    wait_s = (first_token_timeout_s if first_token_ms is None else max(deadline - now, 0.1))
                    if now >= deadline:
                        raise TaskFailure(
                            "MODEL_TIMEOUT", f"模型生成超时（{timeout_s:.0f}s）",
                            dependency=PROVIDER_NAME, retryable=True,
                        )
                    try:
                        line = await asyncio.wait_for(anext(lines), timeout=max(wait_s, 0.1))
                    except StopAsyncIteration:
                        break
                    except asyncio.TimeoutError:
                        if first_token_ms is None:
                            raise TaskFailure(
                                "MODEL_TIMEOUT",
                                f"模型首 token 超过 {first_token_timeout_s:.0f}s",
                                dependency=PROVIDER_NAME, retryable=True,
                            )
                        raise TaskFailure(
                            "MODEL_TIMEOUT", f"模型生成超时（{timeout_s:.0f}s）",
                            dependency=PROVIDER_NAME, retryable=True,
                        )

                    line = line.strip()
                    if not line:
                        continue
                    try:
                        obj = json.loads(line)
                    except (ValueError, TypeError):
                        continue

                    chunk = str(obj.get("response") or "")
                    if chunk:
                        if first_token_ms is None:
                            first_token_ms = (time.monotonic() - t0) * 1000
                            metrics().record_first_token(first_token_ms)
                            logger.info(
                                "LLM 首 token 延迟 | provider=ollama | model=%s | firstTokenMs=%.0f",
                                model, first_token_ms,
                            )
                        buf.append(chunk)
                    if obj.get("done"):
                        break
        except TaskFailure:
            raise
        except httpx.TimeoutException:
            raise TaskFailure(
                "MODEL_TIMEOUT", f"模型响应超时（{timeout_s:.0f}s）",
                dependency=PROVIDER_NAME, retryable=True,
            )
        except httpx.HTTPError as exc:
            raise TaskFailure(
                "CAPABILITY_UNAVAILABLE", f"模型服务请求失败（{exc.__class__.__name__}）",
                dependency=PROVIDER_NAME, retryable=True,
            )

    text = "".join(buf)
    if not text:
        # 流式拿到空响应：回退非流式再判（避免把"只支持非流式"的服务判成空输出）
        logger.warning("流式返回空响应，回退非流式 | model=%s", model)
        text, actual_model = await _generate_nonstream(
            settings, payload, timeout_s=timeout_s, transport=transport
        )
        return text, actual_model, "stream-empty"

    metrics().record_stream_ok()
    return text, model, ""
