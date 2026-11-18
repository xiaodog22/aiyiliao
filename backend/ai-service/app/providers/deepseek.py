"""DeepSeek provider：第二级兜底（OpenAI 兼容 `/chat/completions`）。

设计要点：
  - **未配置 key → 直接跳过**（fail-fast，不空转、不发起请求），由 chain 继续走兜底；
  - key 只从环境变量读，**不进日志**（错误文案里只出现 HTTP 状态码）；
  - `format=json` 映射为 `response_format={"type":"json_object"}`，与 Ollama 的
    `format=json` 语义对齐；官方 JSON Output 要求 prompt 含小写 `json` 字样，
    执行器模板写的是大写「JSON」，故在本层补一条最小约束，不改四份业务模板；
  - **显式关闭思考模式**（`thinking.type=disabled` + `reasoning_effort=none`）：官方默认
    开启 effort=high，会让 temperature 静默失效、额外产生 reasoning tokens 计费并拖长延迟，
    与「本地首级失败后快速兜底」的定位冲突；
  - 检查 `finish_reason`：length / content_filter / aborted 等一律结构化失败，
    不把被截断的 JSON 交给 `parse_json_strict` 碰运气；
  - 官方错误码分流：401/403 鉴权、402 余额、408/504 超时、429/5xx 暂不可用。

2026-11-15 官方口径：模型名仅 `deepseek-flash` / `deepseek-v4-pro`，`deepseek-chat` 已不在
列表；BASE URL `https://api.deepseek.com`。模型名由 `AI_DEEPSEEK_MODEL` 注入，勿在此写死。
"""

from __future__ import annotations

import logging
from typing import Optional

import httpx

from ..config import Settings
from ..tasks import TaskFailure

logger = logging.getLogger("ai-service.providers.deepseek")

PROVIDER_NAME = "deepseek"
# 官方 JSON Output 要求 prompt 中出现小写 "json"；执行器模板是大写「JSON」，补这一条最小约束。
_JSON_HINT = "Output valid json only, following the json format shown above."


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

    # 出境策略（审计 H10）：domestic = 医疗数据不出境，即使本 provider 被误装配也在此拦死。
    if (settings.egress_policy or "allow") == "domestic":
        raise NotConfigured()

    system = str(payload.get("system") or "")
    prompt = str(payload.get("prompt") or "")
    # 出境前强制脱敏（审计 H10）：第三方云只会拿到打过码的文本。
    # 这里不做语义改写（会破坏诊疗语境），只做可机器判定的 PHI 替换。
    from ..redact import deep_sanitize

    system = deep_sanitize(system)
    prompt = deep_sanitize(prompt)
    json_mode = str(payload.get("format") or "") == "json"
    if json_mode and "json" not in (system + prompt):
        system = (system + "\n" + _JSON_HINT).strip()

    messages: list[dict] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": prompt})

    options = payload.get("options") or {}
    body: dict = {
        "model": settings.deepseek_model,
        "messages": messages,
        "stream": False,
        "thinking": {"type": "disabled"},
        "reasoning_effort": "none",
        "temperature": float(options.get("temperature", 0.3)),
        "max_tokens": int(options.get("num_predict", 512)),
    }
    if json_mode:
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

    status = resp.status_code
    if status in (401, 403):
        # key 失效/无权限：不重试（重试只会持续 401，还烧配额）
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"DeepSeek 鉴权失败（HTTP {status}）",
            dependency=PROVIDER_NAME, retryable=False,
        )
    if status == 402:
        logger.warning("DeepSeek 账户余额不足（HTTP 402），云端兜底不可用")
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", "DeepSeek 账户余额不足（HTTP 402）",
            dependency=PROVIDER_NAME, retryable=False,
        )
    if status in (408, 504):
        raise TaskFailure(
            "MODEL_TIMEOUT", f"DeepSeek 响应超时（HTTP {status}）",
            dependency=PROVIDER_NAME, retryable=True,
        )
    if status == 429 or status >= 500:
        raise TaskFailure(
            "MODEL_UNAVAILABLE", f"DeepSeek 暂不可用（HTTP {status}）",
            dependency=PROVIDER_NAME, retryable=True,
        )
    if status >= 400:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"DeepSeek 请求被拒（HTTP {status}）",
            dependency=PROVIDER_NAME, retryable=False,
        )

    try:
        data = resp.json()
        choice = data["choices"][0]
        text = str((choice.get("message") or {}).get("content") or "")
        finish = str(choice.get("finish_reason") or "")
        model = str(data.get("model") or settings.deepseek_model)
        usage = data.get("usage") or {}
    except (ValueError, TypeError, KeyError, IndexError, AttributeError):
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "DeepSeek 响应结构不合法",
            dependency=PROVIDER_NAME, retryable=True,
        )

    # 只记用量与状态，不记 URL / key / 正文（契约：第三方原始报文与用户原文不得外泄）。
    logger.info(
        "DeepSeek 调用完成 | model=%s | finish=%s | promptTokens=%s | completionTokens=%s | cachedTokens=%s",
        model, finish or "n/a", usage.get("prompt_tokens"), usage.get("completion_tokens"),
        usage.get("prompt_cache_hit_tokens"),
    )

    if finish in ("length", "content_filter", "insufficient_system_resource", "aborted"):
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", f"DeepSeek 输出未完成（finish_reason={finish}）",
            dependency=PROVIDER_NAME, retryable=True,
        )
    if not text.strip():
        # JSON 模式下官方会把非 JSON 内容替换成空格 → content 可能全是空白，不能当成功。
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "DeepSeek 返回空输出",
            dependency=PROVIDER_NAME, retryable=True,
        )
    return text, model
