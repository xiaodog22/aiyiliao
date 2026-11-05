"""M2 生成类执行器共享的 LLM 助手。

统一收口四件事，避免 CHAT / CARE_PLAN 各写一份后行为漂移：
  1. 档位 → 模型名解析（small-default / large-upgrade）；
  2. 就位性**快降级**（服务不可达 / 模型缺失 → CAPABILITY_UNAVAILABLE，秒级返回）；
  3. 一次生成调用（**统一走 providers.chain 三步走链**：Ollama → DeepSeek → 兜底）；
  4. 输出解析与结构校验（不合法即失败，**绝不缝合半成品**）。

与 2026-11-04 之前的行为差异：
  - 生成不再直连 Ollama，而是经 `providers.chain`——Ollama 首 token 超时后自动切 DeepSeek；
  - `dependency` 由 `chain.current_provider()` 动态归因（最后一跳是谁就报谁，不硬编码 ollama）；
  - `AI_OLLAMA_FIRST_TOKEN_TIMEOUT` 只卡**首个 token**，不卡总生成时长。

红线：不造假、不静默、错误码与 dependency 如实上报（O-10 原则）。
"""

from __future__ import annotations

import json
import logging
from typing import Any, Optional

import httpx

from ..config import Settings
from ..metrics import metrics
from ..providers import chain
from ..tasks import TaskContext, TaskFailure

logger = logging.getLogger("ai-service.executors.llm")

LARGE_PROFILE = "large-upgrade"
PROVENANCE_AI = "AI_GENERATED"
MAX_INPUT_CHARS = 2000  # 与 ai-openapi TaskSubmitRequest.inputInline 上限一致


def resolve_model(settings: Settings, profile: Optional[str]) -> str:
    """资源档 → 具体模型标签（具体模型由配置决定，契约不绑定模型名）。"""
    return settings.large_model if profile == LARGE_PROFILE else settings.small_model


def current_dependency() -> str:
    """当前（或最后）实际使用/尝试的 provider，供结果 `llmSource` 与错误 `dependency` 使用。"""
    return chain.current_provider()


async def ensure_model_ready(
    probe, model: str, *, settings: Optional[Settings] = None, dependency: str = "ollama",
) -> None:
    """就位性快降级：探针带 5s 缓存，通常毫秒级返回。

    `settings` 传入时按「是否配好第二级」自动判断：已配置 DeepSeek → 本地模型缺失
    **不再硬失败**，交给链去尝试第二级；否则保持原有的秒级 CAPABILITY_UNAVAILABLE（向后兼容）。
    """
    allow_fallback = chain.has_fallback(settings) if settings is not None else False
    tags = await probe.ollama_tags()
    if tags is None:
        if allow_fallback:
            logger.info("本机模型服务不可达，跳过就位检查，交给 provider 链降级")
            return
        raise TaskFailure(
            "CAPABILITY_UNAVAILABLE", f"本机模型服务不可达（{dependency}）",
            dependency=dependency, retryable=True,
        )
    if model not in tags:
        if allow_fallback:
            logger.info("本地模型 %s 未安装，跳过就位检查，交给 provider 链降级", model)
            return
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
    first_token_timeout_s: Optional[float] = None,
    fallback_timeout_s: Optional[float] = None,
) -> tuple[str, str]:
    """经 provider 链生成，返回 (response 文本, 实际模型名)。

    失败一律 TaskFailure（可识别码），不抛裸异常、不返回半成品。

    参数语义：
    - `first_token_timeout_s`：Ollama **首 token** 阈值（不填则用全局 `AI_OLLAMA_FIRST_TOKEN_TIMEOUT`）；
      超时即切第二级，不是"总时长超时"——7B 生成 300 token 在 CPU 上远超 6~10s。
    - `fallback_timeout_s`：第二级（DeepSeek）的单次预算；不填则复用 `timeout_s`。
    - `transport`：测试注入固定 transport（与生产复用 client 行为一致）。
    """
    payload: dict = {
        "model": model, "system": system, "prompt": prompt, "stream": False, "options": options,
    }
    if json_mode:
        payload["format"] = "json"  # 结构化输出：Ollama 用 format，DeepSeek 用 response_format

    first = first_token_timeout_s
    if first is None:
        first = settings.ollama_first_token_timeout

    result = await chain.generate(
        settings,
        payload,
        timeout_s=timeout_s,
        first_token_timeout_s=float(first),
        fallback_timeout_s=fallback_timeout_s,
        transport=transport,
    )
    if result.stream_fallback_reason:
        # 流式入口不可用 → 同 provider 非流式已成功：只降级不报错，但必须留痕
        logger.warning(
            "LLM 流式失败，回退非流式 | model=%s | reason=%s",
            model, result.stream_fallback_reason,
        )
        metrics().record_stream_fallback(result.stream_fallback_reason)
    return result.text, result.model


def parse_json_strict(response_text: str, dependency: Optional[str] = None) -> Any:
    """解析模型返回的 JSON 文本；不合法 → MODEL_OUTPUT_INVALID（不猜测、不修补）。

    `dependency` 默认取链记录的**实际** provider（可能是 deepseek），避免把第二级的问题
    错报成"本机 Ollama 输出不合法"。
    """
    try:
        return json.loads(response_text or "")
    except (ValueError, TypeError):
        raise TaskFailure(
            "MODEL_OUTPUT_INVALID", "模型输出不是合法 JSON",
            dependency=dependency or current_dependency(), retryable=False,
        )


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
