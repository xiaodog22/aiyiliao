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

import hashlib
import logging
import time
from pathlib import Path
from typing import Awaitable, Callable, Optional

from ..config import Settings
from ..tasks import TaskContext, TaskFailure
from ..voice import resolve_voice, sign_audio_token, synthesize, tts_engine_name, tts_status
from ._llm import require_input_text

logger = logging.getLogger("ai-service.executors.tts")

PROMPT_TEMPLATE_VERSION = None  # TTS 无提示词模板（如实为 None，不编造版本号）

Synthesizer = Callable[[Settings, str, str, Path], Awaitable[None]]


def build_tts_executor(
    settings: Settings,
    probe,
    *,
    synthesizer: Optional[Synthesizer] = None,
):
    """构造 TTS 执行器。synthesizer 仅测试注入；生产走 app.voice.synthesize。"""
    synth = synthesizer or synthesize

    async def executor(task: dict, ctx: TaskContext) -> dict:
        request_start = time.perf_counter()   # 首次字节/总耗时观测起点（缓存命中也要报数）
        text = require_input_text(task)
        status, detail = tts_status(settings)
        if status != "available":
            raise TaskFailure("TTS_UNAVAILABLE", detail, dependency="tts_provider", retryable=True)

        engine_voice = resolve_voice(settings, task.get("voice"))
        locale = str(task.get("locale") or "zh-CN")
        digest = hashlib.sha256(f"{text}|{engine_voice}|{locale}".encode("utf-8")).hexdigest()[:16]
        out_path = Path(settings.tts_output_dir) / f"{digest}.mp3"

        await ctx.set_phase("synthesis")
        # 缓存有效性 = 存在且非空：0 字节残留不算命中，先清掉再重合成（防永久毒化）
        cached = out_path.exists() and out_path.stat().st_size > 0
        metrics: dict = {}
        if not cached:
            if out_path.exists():
                logger.warning("TTS 清理 0 字节残留产物 file=%s task=%s", out_path.name, task.get("taskId"))
                try:
                    out_path.unlink()
                except OSError:
                    pass
            try:
                # 合成器可返回耗时画像（voice.synthesize 新版）；注入的测试桩返回 None 也照常工作
                produced = await synth(settings, text, engine_voice, out_path)
                metrics = produced if isinstance(produced, dict) else {}
            except Exception as exc:  # 引擎异常一律结构化降级，不暴露内部细节
                logger.warning("TTS 合成失败 task=%s engine=%s err=%s: %s",
                               task.get("taskId"), tts_engine_name(settings),
                               exc.__class__.__name__, str(exc)[:200])
                # 纵深防御：无论合成器如何实现，失败一律清掉可能写出的残片，
                # 否则该文本的摘要名一旦存在（哪怕 0 字节）就会被后续请求当作缓存命中 → 永久毒化。
                try:
                    if out_path.exists():
                        out_path.unlink()
                except OSError:
                    pass
                raise TaskFailure("TTS_UNAVAILABLE", "语音合成失败（引擎异常），请保留文字展示",
                                  dependency="tts_provider", retryable=True)
        if not out_path.exists() or out_path.stat().st_size == 0:
            raise TaskFailure("TTS_UNAVAILABLE", "语音合成产物为空，不作为成功返回",
                              dependency="tts_provider", retryable=True)

        token = sign_audio_token(settings, out_path.name, settings.tts_url_ttl_seconds)
        public_path = (settings.tts_public_path or "/internal/v1/tts/audio").rstrip("/")
        audio_url = f"{settings.tts_public_base.rstrip('/')}{public_path}/{out_path.name}?token={token}"
        total_ms = round((time.perf_counter() - request_start) * 1000, 1)
        first_byte = metrics.get("firstByteMs")
        logger.info(
            "TTS 完成 task=%s engine=%s cached=%s mode=%s firstByteMs=%s totalMs=%.1f bytes=%d",
            task.get("taskId"), tts_engine_name(settings), cached,
            metrics.get("mode") or ("cache" if cached else "injected"),
            f"{first_byte:.1f}" if isinstance(first_byte, (int, float)) else "n/a",
            total_ms, out_path.stat().st_size,
        )

        return {
            "result": {"audioUrl": audio_url, "language": locale},
            "model": {
                "modelId": f"tts-{tts_engine_name(settings)}",
                "modelProfile": task.get("modelProfile") or "small-default",
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                "cached": cached,
            },
        }

    return executor


__all__ = ["build_tts_executor", "synthesize", "tts_status"]
