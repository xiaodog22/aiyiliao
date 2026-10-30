"""ASR 执行器：语音识别（M2 · D2.3）。

输入（任务字段）：
- `inputRef`：形如 `asr:{id}` 的音频引用（业务侧约定 `AI_ASR_AUDIO_DIR/{id}.<ext>`）；
- `locale`：语言标记（透传，不参与识别决策）。

输出（result）：`{"transcript": "<文本>", "language": "zh-CN" | null, "hasTimestamps": false}`。
**语言与时间戳只透传模型真实给出的值**；不提供即 `false`/`null`（不猜测）。

红线：
- 权重未就绪 / 音频不可取 → `CAPABILITY_UNAVAILABLE`（如实，不伪造转写、不 200+空对象）；
- 转写结果必须经用户确认才能进入诊疗流程（本执行器只产文本草稿，不落任何库）。
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Awaitable, Callable, Optional

from ..config import Settings
from ..tasks import TaskContext, TaskFailure
from ..voice import asr_status, resolve_audio_path, transcribe
from ._llm import trim

logger = logging.getLogger("ai-service.executors.asr")

PROMPT_TEMPLATE_VERSION = None  # ASR 无提示词模板（如实为 None）

Transcriber = Callable[[Settings, Path, Optional[str]], Awaitable[tuple[str, Optional[str]]]]


def build_asr_executor(
    settings: Settings,
    probe,
    *,
    transcriber: Optional[Transcriber] = None,
    audio_resolver: Optional[Callable[[Settings, Optional[str]], Optional[Path]]] = None,
):
    """构造 ASR 执行器。transcriber/audio_resolver 仅测试注入；生产走 app.voice。"""
    run_transcribe = transcriber or transcribe
    resolve_audio = audio_resolver or resolve_audio_path

    async def executor(task: dict, ctx: TaskContext) -> dict:
        status, detail = asr_status(settings)
        if status != "available":
            raise TaskFailure("CAPABILITY_UNAVAILABLE", detail, dependency="asr_model", retryable=True)

        audio_path = resolve_audio(settings, task.get("inputRef"))
        if audio_path is None:
            raise TaskFailure(
                "CAPABILITY_UNAVAILABLE",
                "音频引用不可取用（未配置音频目录或引用无效）—— 能力如实不可用",
                dependency="asr_model", retryable=True,
            )

        await ctx.set_phase("generation")
        try:
            text, language = await run_transcribe(settings, audio_path, task.get("locale"))
        except Exception as exc:
            logger.warning("ASR 识别失败 task=%s err=%s", task.get("taskId"), exc.__class__.__name__)
            raise TaskFailure("CAPABILITY_UNAVAILABLE", "语音识别失败（引擎异常）",
                              dependency="asr_model", retryable=True)

        transcript = trim(text, 2000)
        if transcript is None:
            raise TaskFailure("MODEL_OUTPUT_INVALID", "识别结果为空", dependency="asr_model", retryable=False)

        logger.info("ASR 完成 task=%s chars=%d", task.get("taskId"), len(transcript))
        return {
            "result": {
                "transcript": transcript,
                "language": language,
                "hasTimestamps": False,
            },
            "model": {
                "modelId": "asr-funasr",
                "modelProfile": task.get("modelProfile") or "small-default",
                "promptTemplateVersion": PROMPT_TEMPLATE_VERSION,
                "cached": False,
            },
        }

    return executor


__all__ = ["build_asr_executor"]
