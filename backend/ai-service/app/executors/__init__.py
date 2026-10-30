"""执行器注册表：taskType → 实际能力。

M1：TRIAGE（科室推荐补充档）。
M2：CHAT（问诊对话）/ CARE_PLAN（照护建议）/ TTS（语音合成）/ ASR（语音识别）。
M3：RAG（向量检索，特征开关 RAG_ENABLED 控制）。
    任务类型清单以 ai-openapi.yaml 的 TaskType 枚举为上限，**不改契约**。
"""

from __future__ import annotations

from typing import Optional

import httpx

from ..capabilities import CapabilityProbe
from ..config import Settings
from ..models import TaskType
from .asr import build_asr_executor
from .careplan import PROMPT_TEMPLATE_VERSION as CAREPLAN_PROMPT_TEMPLATE_VERSION
from .careplan import build_careplan_executor
from .chat import PROMPT_TEMPLATE_VERSION as CHAT_PROMPT_TEMPLATE_VERSION
from .chat import build_chat_executor
from .interpret import PROMPT_TEMPLATE_VERSION as INTERPRET_PROMPT_TEMPLATE_VERSION
from .interpret import build_interpret_executor
from .rag import PROMPT_TEMPLATE_VERSION as RAG_PROMPT_TEMPLATE_VERSION
from .rag import build_rag_executor
from .triage import PROMPT_TEMPLATE_VERSION as TRIAGE_PROMPT_TEMPLATE_VERSION
from .triage import build_triage_executor
from .tts import build_tts_executor

__all__ = [
    "build_default_executors",
    "build_triage_executor",
    "build_chat_executor",
    "build_careplan_executor",
    "build_interpret_executor",
    "build_rag_executor",
    "build_tts_executor",
    "build_asr_executor",
    "CACHE_DESCRIPTORS",
]

# 内容寻址缓存（D2.4）的描述信息：只有登记在此的类型才参与缓存。
# 键里的模板版本必须与执行器实际使用的模板一致，否则模板升级不会失效旧条目。
# ASR（音频不可复用）与 TTS（产物级内容寻址，见 executors/tts.py）**不在此列**。
CACHE_DESCRIPTORS: dict = {
    TaskType.TRIAGE: {"promptTemplateVersion": TRIAGE_PROMPT_TEMPLATE_VERSION},
    TaskType.CHAT: {"promptTemplateVersion": CHAT_PROMPT_TEMPLATE_VERSION},
    TaskType.CARE_PLAN: {"promptTemplateVersion": CAREPLAN_PROMPT_TEMPLATE_VERSION},
    TaskType.INTERPRET: {"promptTemplateVersion": INTERPRET_PROMPT_TEMPLATE_VERSION},
    TaskType.RAG: {"promptTemplateVersion": RAG_PROMPT_TEMPLATE_VERSION},
}


def build_default_executors(
    settings: Settings,
    probe: CapabilityProbe,
    transport: Optional[httpx.AsyncBaseTransport] = None,
    *,
    tts_synthesizer=None,
    asr_transcriber=None,
    asr_audio_resolver=None,
) -> dict:
    """生产默认执行器集合。

    transport / *_synthesizer / *_transcriber / *_resolver 仅供测试注入；
    生产为 None（分别走真实 httpx / app.voice）。
    """
    executors = {
        TaskType.TRIAGE: build_triage_executor(settings, probe, transport=transport),
        TaskType.CHAT: build_chat_executor(settings, probe, transport=transport),
        TaskType.CARE_PLAN: build_careplan_executor(settings, probe, transport=transport),
        TaskType.INTERPRET: build_interpret_executor(settings, probe, transport=transport),
        TaskType.TTS: build_tts_executor(settings, probe, synthesizer=tts_synthesizer),
        TaskType.ASR: build_asr_executor(
            settings, probe, transcriber=asr_transcriber, audio_resolver=asr_audio_resolver,
        ),
    }
    
    # RAG 执行器：特征开关控制（默认关闭）
    if settings.rag_enabled:
        executors[TaskType.RAG] = build_rag_executor(settings, probe, transport=transport)
    
    return executors
