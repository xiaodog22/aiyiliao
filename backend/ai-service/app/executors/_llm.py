"""M2 生成类执行器共享的 Ollama 助手（TRIAGE 执行器保持自包含，此处不改动它）。

统一收口四件事，避免 CHAT / CARE_PLAN 各写一份后行为漂移：
  1. 档位 → 模型名解析（small-default / large-upgrade）；
  2. 就位性**快降级**（服务不可达 / 模型缺失 → CAPABILITY_UNAVAILABLE，秒级返回）；
  3. 一次生成调用（独立短超时；超时/HTTP 错误 → 结构化 TaskFailure）；
  4. 输出解析与结构校验（不合法即失败，**绝不缝合半成品**）。

红线：不造假、不静默、错误码与 dependency 如实上报（O-10 原则）。
"""

from __future__ import annotations

import json
import logging
import time
from typing import Any, Optional

import httpx

from ..config import Settings
from ..http_client import ollama_client
from ..metrics import metrics
from ..tasks import TaskContext, TaskFailure

logger = logging.getLogger("ai-service.executors.llm")


class _StreamFallback(Exception):
    """流式生成中途失败的信号：捕获后回退到非流式调用（不抛给用户）。"""


def _safe_err_name(exc: BaseException) -> str:
    return exc.__class__.__name__

LARGE_PROFILE = "large-upgrade"
PROVENANCE_AI = "AI_GENERATED"
MAX_INPUT_CHARS = 2000  # 与 ai-openapi TaskSubmitRequest.inputInline 上限一致


def resolve_model(settings: Settings, profile: Optional[str]) -> str:
    """资源档 → 具体模型标签（具体模型由配置决定，契约不绑定模型名）。"""
    return settings.large_model if profile == LARGE_PROFILE else settings.small_model


async def ensure_model_ready(probe, model: str, *, dependency: str = "ollama") -> None:
    """就位性快降级：探针带 5s 缓存，通常毫秒级返回。"""
    tags = await probe.ollama_tags()
    if tags is None:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"本机模型服务不可达（{dependency}）",
            dependency=dependency, retryable=True,
        )
    if model not in tags:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"模型 {model} 未安装",
            dependency=dependency, retryable=True,
        )


def require_input_text(task: dict, *, max_chars: int = MAX_INPUT_CHARS) -> str:
    """取并校验 inputInline；空 → INVALID_INPUT（不消耗模型算力）。"""
    text = str(task.get("inputInline") or "").strip()
    if not text:
        raise TaskFailure(
            "INVALID_INPUT", f"{task.get('taskType')} 任务需要 inputInline 文本",
            dependency=None, retryable=False,
        )
    if len(text) > max_chars:
        logger.warning("输入超长，截断到 %d 字符（task=%s）", max_chars, task.get("taskId"))
        # ⚠️ 保留**尾部**：多轮问诊里 inputInline 是「患者：…/医生助手：…」逐行上下文，
        #    本轮与最近几轮才是当前病情；截头部会把当前主诉丢掉，只剩开场白。
        text = text[-max_chars:]
    return text


def build_options(task: dict, *, temperature: float, num_predict: int) -> dict:
    """按任务 generationParameters 覆盖默认采样参数（键已在提交侧白名单过滤）。"""
    options: dict = {"temperature": temperature, "num_predict": num_predict}
    gen = task.get("generationParameters") or {}
    if gen.get("temperature") is not None:
        options["temperature"] = float(gen["temperature"])
    if gen.get("topP") is not None:
        options["top_p"] = float(gen["topP"])
    if gen.get("maxOutputTokens") is not None:
        options["num_predict"] = int(gen["maxOutputTokens"])
    return options


def _ollama_generate_url(settings: Settings) -> str:
    return settings.ollama_url.rstrip("/") + "/api/generate"


async def _post_ollama_generate(
    client: httpx.AsyncClient, settings: Settings, payload: dict, timeout_s: float
) -> httpx.Response:
    """POST /api/generate 一次，错误统一映射为 TaskFailure（非流式调用路径共用）。

    连接级错误（超时/不可达）→ MODEL_TIMEOUT / CAPABILITY_UNAVAILABLE（可重试）；
    4xx/5xx → CAPABILITY_UNAVAILABLE（404 模型缺失）或 MODEL_UNAVAILABLE（其他）。
    不静默、不缝合半成品。
    """
    try:
        resp = await client.post(
            _ollama_generate_url(settings),
            json=payload,
            timeout=httpx.Timeout(timeout_s, connect=settings.probe_timeout_seconds),
        )
    except httpx.TimeoutException:
        raise TaskFailure("MODEL_TIMEOUT", f"模型响应超时（{timeout_s:.0f}s）", dependency="ollama", retryable=True)
    except httpx.HTTPError as exc:
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"模型服务请求失败（{_safe_err_name(exc)}）",
            dependency="ollama", retryable=True,
        )
    if resp.status_code == 404:
        raise TaskFailure("CAPABILITY_UNAVAILABLE", f"模型 {payload.get('model')} 未安装或不可用", dependency="ollama", retryable=True)
    if resp.status_code >= 400:
        raise TaskFailure("MODEL_UNAVAILABLE", f"模型服务返回 HTTP {resp.status_code}", dependency="ollama", retryable=True)
    return resp


async def _generate_streaming(
    settings: Settings, model: str, payload: dict, timeout_s: float,
    *, transport: Optional[httpx.AsyncBaseTransport] = None,
) -> tuple[str, str]:
    """流式生成：stream=True 累积 partial response，返回 (全文, 模型名)。

    成功时记录首 token 延迟（metrics）。任何中途失败（连接错误 / 流式 4xx / 空响应）
    抛出 `_StreamFallback`，由 `generate_text` 捕获并回退非流式。
    """
    stream_payload = {**payload, "stream": True}
    buf: list[str] = []
    first_token_ms: Optional[float] = None
    t0 = time.monotonic()
    async with ollama_client(settings, transport=transport) as client:
        try:
            async with client.stream(
                "POST",
                _ollama_generate_url(settings),
                json=stream_payload,
                timeout=httpx.Timeout(timeout_s, connect=settings.probe_timeout_seconds),
            ) as resp:
                if resp.status_code >= 400:
                    # 让非流式分支用同样的错误映射处理（保持错误码一致）
                    raise _StreamFallback(httpx.HTTPStatusError(f"stream status {resp.status_code}", request=resp.request, response=resp))
                async for line in resp.aiter_lines():
                    line = line.strip()
                    if not line:
                        continue
                    if first_token_ms is None:
                        first_token_ms = (time.monotonic() - t0) * 1000
                    try:
                        obj = json.loads(line)
                    except (ValueError, TypeError):
                        continue
                    if obj.get("done"):
                        break
                    chunk = obj.get("response") or ""
                    if chunk:
                        buf.append(chunk)
        except (httpx.TimeoutException, httpx.HTTPError) as exc:
            raise _StreamFallback(exc)

    text = "".join(buf)
    if not text:
        # 流式拿到空响应：回退非流式（避免误判为正常空输出）
        raise _StreamFallback(RuntimeError("stream produced empty response"))
    if first_token_ms is not None:
        metrics().record_first_token(first_token_ms)
        metrics().record_stream_ok()
        logger.info("LLM 首 token 延迟 | model=%s | firstTokenMs=%.0f | chars=%d", model, first_token_ms, len(text))
    return text, str(model)


async def generate_text(
    settings: Settings,
    model: str,
    system: str,
    prompt: str,
    options: dict,
    timeout_s: float,
    *,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    json_mode: bool = False,
) -> tuple[str, str]:
    """调用 Ollama /api/generate，返回 (response 文本, 实际模型名)。

    失败一律 TaskFailure（可识别码），不抛裸异常、不返回半成品。

    并发/复用（2026-10-22）：
    - 底层 httpx client 走 `ollama_client`（复用进程级单例或一次性 client，受 `llm_http_client_reuse` 控制）。
    - 当 `settings.llm_stream=True`（新行为）时优先走流式；流式中途失败自动回退非流式
      （WARN + metrics 计数），返回契约不变。
    - `transport` 注入（测试）：固定一次性 client，行为与优化前一致。
    """
    payload: dict = {
        "model": model, "system": system, "prompt": prompt, "stream": False, "options": options,
    }
    if json_mode:
        payload["format"] = "json"  # 小模型结构化输出：强制 JSON，降低跑偏概率

    # 新行为：流式优先（transport 注入场景也走流式，便于离线测试；回退路径同样走 transport）
    if settings.llm_stream:
        try:
            return await _generate_streaming(settings, model, payload, timeout_s, transport=transport)
        except _StreamFallback as fb:
            logger.warning(
                "LLM 流式失败，回退非流式 | model=%s | reason=%s",
                model, _safe_err_name(fb.args[0]) if fb.args else "unknown",
            )
            metrics().record_stream_fallback(_safe_err_name(fb.args[0]) if fb.args else "unknown")
            payload = {**payload, "stream": False}

    async with ollama_client(settings, transport=transport) as client:
        resp = await _post_ollama_generate(client, settings, payload, timeout_s)
        try:
            raw = resp.json()
            text = str(raw.get("response") or "")
            actual_model = str(raw.get("model") or model)
        except (ValueError, TypeError):
            raise TaskFailure("MODEL_OUTPUT_INVALID", "模型响应不是合法 JSON", dependency="ollama", retryable=False)
    return text, actual_model


def parse_json_strict(response_text: str) -> Any:
    """解析模型返回的 JSON 文本；不合法 → MODEL_OUTPUT_INVALID（不猜测、不修补）。"""
    try:
        return json.loads(response_text or "")
    except (ValueError, TypeError):
        raise TaskFailure("MODEL_OUTPUT_INVALID", "模型输出不是合法 JSON", dependency="ollama", retryable=False)


def trim(value: Any, limit: int) -> Optional[str]:
    """非空字符串裁剪；空/null → None（让契约 NON_NULL 序列化自然省略）。"""
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:limit]


async def set_phase(ctx: TaskContext, phase: str) -> None:
    """记录阶段名（不是百分比；模型不提供的精度不得伪造）。"""
    await ctx.set_phase(phase)
