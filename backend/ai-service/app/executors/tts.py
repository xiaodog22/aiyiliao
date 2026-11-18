"""TTS 执行器：语音合成（M2 · D2.3）。

输入（任务字段）：
- `inputInline`：待合成文本（业务侧已脱敏/规范化）；
- `voice`：业务音色 ID（未知音色**回退默认**，不报错）；
- `locale`：语言标记（zh-CN 等）。

输出（result）：`{"audioUrl": "<短期签名 URL>", "language": "zh-CN"}`。
**不内联音频字节**；URL = `AI_TTS_PUBLIC_BASE` + `AI_TTS_PUBLIC_PATH` + `/{file}?token=exp.sig`。
默认 path 为本服务内部通道 `/internal/v1/tts/audio`；对外部署时指向客户端可达入口（经网关单入口 = `/api/gw/tts/audio`）。

红线（08A D2.3 / O-10）：
- 引擎未配置或不可用 → `TTS_UNAVAILABLE`（可重试），**不播占位音、不 200+空对象**；
- 引擎标识如实返回（settings.tts_engine）；合成产物为**非权威**中间件，重启可失；
- 相同文本+音色+语言 → 命中本地文件（`cached=true`），不重复消耗算力。

性能观测（2026-10-22）：每次任务都打一条汇总日志
`cached= / mode= / firstByteMs= / totalMs= / bytes=`；缓存命中走纯文件路径（无网络、无引擎调用），
合成未命中时 `firstByteMs` 取自 `voice.synthesize()` 的流式画像（`TTS_STREAM=false` 回滚档为 n/a，不编造）。

缓存命中契约（修正 2026-10-15）：**命中 = 产物存在且非空**。0 字节残留（历史失败产物）
既不算命中、也不得留在盘上——先删除再重合成，否则该文本会被永久毒化（每次跳过合成→每次判空失败）。
"""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional

from ..config import Settings
from ..tasks import TaskContext, TaskFailure
from ..voice import (
    ENGINE_FORMAT,
    resolve_voice,
    sign_audio_token,
    synthesize,
    tts_engines_for_locale,
    tts_engine_name,
    tts_status,
)
from ._llm import require_input_text

logger = logging.getLogger("ai-service.executors.tts")

PROMPT_TEMPLATE_VERSION = None  # TTS 无提示词模板（如实为 None，不编造版本号）

Synthesizer = Callable[..., Awaitable[object]]


def build_tts_executor(
    settings: Settings,
    probe,
    *,
    synthesizer: Optional[Synthesizer] = None,
):
    """构造 TTS 执行器。synthesizer 仅测试注入；生产走 app.voice.synthesize。"""
    synth = synthesizer or synthesize
    # 测试桩可能只接受旧的四参数签名；生产 synthesize 支持 engine/locale 关键字。
    try:
        accepts_engine_kw = (
            any(p.kind == inspect.Parameter.VAR_KEYWORD
                for p in inspect.signature(synth).parameters.values())
            or "engine" in inspect.signature(synth).parameters
        )
    except (TypeError, ValueError):  # pragma: no cover - C 扩展/内置可调用
        accepts_engine_kw = False

    async def _call_synth(text: str, locale: str, engine: str, voice: str, path: Path, budget: float):
        call = (synth(settings, text, voice, path, engine=engine, locale=locale)
                if accepts_engine_kw else synth(settings, text, voice, path))
        return await asyncio.wait_for(call, timeout=max(0.5, budget))

    async def executor(task: dict, ctx: TaskContext) -> dict:
        request_start = time.perf_counter()   # 首次字节/总耗时观测起点（缓存命中也要报数）
        text = require_input_text(task)
        locale = str(task.get("locale") or "zh-CN")
        engines = tts_engines_for_locale(settings, locale)
        if not engines:
            status, detail = tts_status(settings)
            # 服务端无引擎：若端侧 WechatSI 被允许，提示客户端可切端侧（但本服务不伪造音频）
            hint = "；可在端侧使用微信同声传译（仅普通话）或保留文字" \
                if settings.provider_allowed("wechat_si") else "；请保留文字展示"
            raise TaskFailure(
                "TTS_UNAVAILABLE", (detail if status != "available" else "该语言无服务端 TTS 引擎") + hint,
                dependency="tts_provider", retryable=True,
            )

        await ctx.set_phase("synthesis")
        failures: list[str] = []
        degraded = False
        for index, engine in enumerate(engines):
            ext, mime = ENGINE_FORMAT[engine]
            engine_voice = resolve_voice(settings, task.get("voice"), engine=engine, locale=locale)
            # 缓存键必须含引擎：qwen3(wav) 与 edge(mp3) 不能互相当命中。
            digest = hashlib.sha256(
                f"{engine}|{text}|{engine_voice}|{locale}".encode("utf-8")
            ).hexdigest()[:16]
            out_path = Path(settings.tts_output_dir) / f"{digest}.{ext}"
            cached = out_path.exists() and out_path.stat().st_size > 0

            if cached:
                metrics: dict = {}
            else:
                if out_path.exists():
                    logger.warning("TTS 清理 0 字节残留产物 file=%s task=%s", out_path.name, task.get("taskId"))
                    try:
                        out_path.unlink()
                    except OSError:
                        pass
                # 每级预算从同一个总预算扣：qwen3 35s，edge 12s，总 ≤ AI_TTS_TIMEOUT_SECONDS。
                elapsed = time.perf_counter() - request_start
                remaining = float(settings.tts_timeout_seconds) - elapsed
                if remaining <= 0:
                    failures.append(f"{engine}:deadline")
                    break
                level_budget = (settings.tts_qwen3_timeout_seconds if engine == "qwen3"
                                else settings.tts_edge_timeout_seconds)
                budget = min(float(level_budget), remaining)
                try:
                    produced = await _call_synth(text, locale, engine, engine_voice, out_path, budget)
                    metrics = produced if isinstance(produced, dict) else {}
                except Exception as exc:  # 引擎异常一律切下一级，不暴露内部细节
                    failures.append(f"{engine}:{exc.__class__.__name__}")
                    logger.warning("TTS 引擎失败，尝试下一级 task=%s engine=%s err=%s: %s",
                                   task.get("taskId"), engine, exc.__class__.__name__, str(exc)[:200])
                    try:
                        if out_path.exists():
                            out_path.unlink()
                    except OSError:
                        pass
                    degraded = True
                    continue

            if not out_path.exists() or out_path.stat().st_size == 0:
                failures.append(f"{engine}:empty")
                degraded = True
                continue

            if index > 0:
                degraded = True
            token = sign_audio_token(settings, out_path.name, settings.tts_url_ttl_seconds)
            public_path = (settings.tts_public_path or "/internal/v1/tts/audio").rstrip("/")
            audio_url = f"{settings.tts_public_base.rstrip('/')}{public_path}/{out_path.name}?token={token}"
            total_ms = round((time.perf_counter() - request_start) * 1000, 1)
            first_byte = metrics.get("firstByteMs")
            logger.info(
                "TTS 完成 task=%s engine=%s cached=%s mode=%s firstByteMs=%s totalMs=%.1f bytes=%d",
                task.get("taskId"), engine, cached,
                metrics.get("mode") or ("cache" if cached else "injected"),
                f"{first_byte:.1f}" if isinstance(first_byte, (int, float)) else "n/a",
                total_ms, out_path.stat().st_size,
            )
            return {
                "result": {
                    "audioUrl": audio_url,
                    "language": locale,
                    "engine": engine,
                    "mime": mime,
                    "voiceId": task.get("voice") or "",
                    "degraded": degraded,
                },
                "model": {
                    "modelId": f"tts-{engine}",
                    "modelProfile": task.get("modelProfile") or "small-default",
                    "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                    "cached": cached,
                },
            }

        raise TaskFailure(
            "TTS_UNAVAILABLE",
            f"服务端 TTS 链均不可用（{', '.join(failures) or tts_engine_name(settings)}），请保留文字展示",
            dependency="tts_provider", retryable=True,
        )

    return executor


__all__ = ["build_tts_executor", "synthesize", "tts_status"]
