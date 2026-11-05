"""DeepSeek provider：第二级（OpenAI 兼容 `/chat/completions`）。

设计要点：
  - **未配置 key → 直接跳过**（fail-fast，不空转、不发起请求），由 chain 继续走兜底；
  - key 只从环境变量读，**不进日志**（错误文案里只出现 HTTP 状态码）；
  - `format=json` 的调用映射为 `response_format={"type":"json_object"}`，与 Ollama 的
    `format=json` 语义对齐；提示词里已要求输出 JSON（DeepSeek 该模式要求 prompt 含 "json"）。
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from ..config import Settings
from ..tasks import TaskFailure

logger = logging.getLogger("ai-service.providers.deepseek")

PROVIDER_NAME = "deepseek"


class NotConfigured(Exception):
    """未配置 API key：不是失败，chain 应静默跳过本级。"""


def _chat_url(settings: Settings) -> str:
    return settings.deepseek_base_url.rstrip("/") + "/chat/completions"


async def generate(
    settings: Settings,
    payload: dict,
    *,
    timeout_s: float,
    transport: Optional[httpx.AsyncBaseTransport] = None,
) -> tuple[str, str]:
    """一次非流式对话补全，返回 (正文, 实际模型名)。"""
    if not settings.deepseek_api_key:
        raise NotConfigured()

    messages: list[dict] = []
    system = str(payload.get("system") or "")
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": str(payload.get("prompt") or "")})

    options = payload.get("options") or {}
    body: dict = {
        "model": settings.deepseek_model,
        "messages": messages,
        "stream": False,
        "temperature": float(options.get("temperature", 0.3)),
        "max_tokens": int(options.get("num_predict", 512)),
    }
    if str(payload.get("format") or "") == "json":
        body["response_format"] = {"type": "json_object"}

    headers = {"Authorization": f"Bearer {settings.deepseek_api_key}", "Content-Type": "application/json"}

    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(timeout_s, connect=settings.probe_timeout_seconds),
            transport=transport,
            trust_env=False,
        ) as client:
            resp = await client.post(_chat_url(settings), json=body, headers=headers)
    except httpx.TimeoutException:
        raise TaskFailure(
            "MODEL_TIMEOUT", f"DeepSeek 响应超时（{timeout_s:.0f}s）",
            dependency=PROVIDER_NAME, retryable=True,
        )
    except httpx.HTTPError as exc:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"DeepSeek 请求失败（{exc.__class__.__name__}）",
            dependency=PROVIDER_NAME, retryable=True,
        )

    if resp.status_code in (401, 403):
        # key 失效/无权限：不重试（重试只会持续 401，还烧配额）
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"DeepSeek 鉴权失败（HTTP {resp.status_code}）",
            dependency=PROVIDER_NAME, retryable=False,
        )
    if resp.status_code == 429 or resp.status_code >= 500:
        raise TaskFailure(
            "MODEL_UNAVAILABLE", f"DeepSeek 暂不可用（HTTP {resp.status_code}）",
            dependency=PROVIDER_NAME, retryable=True,
        )
    if resp.status_code >= 400:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"DeepSeek 请求被拒（HTTP {resp.status_code}）",
            dependency=PROVIDER_NAME, retryable=False,
        )

    try:
        data = resp.json()
        text = str(data["choices"][0]["message"]["content"] or "")
        model = str(data.get("model") or settings.deepseek_model)
    except (ValueError, TypeError, KeyError, IndexError):
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "DeepSeek 响应结构不合法",
            dependency=PROVIDER_NAME, retryable=True,
        )

    if not text:
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "DeepSeek 返回空输出",
            dependency=PROVIDER_NAME, retryable=True,
        )
    return text, model
