"""请求模型（严格对齐 ai-openapi.yaml 的 TaskSubmitRequest）。

约定：额外字段一律拒绝（additionalProperties: false），未知键不静默丢弃。
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator


class TaskType(str, Enum):
    TRIAGE = "TRIAGE"
    CHAT = "CHAT"
    RAG = "RAG"
    CARE_PLAN = "CARE_PLAN"
    ASR = "ASR"
    TTS = "TTS"
    # 2026-10-22：健康档案报告通俗解读（此前由 Java 侧规则模板拼装，现接真实模型）
    INTERPRET = "INTERPRET"


class ModelProfile(str, Enum):
    SMALL = "small-default"
    LARGE = "large-upgrade"


class Priority(str, Enum):
    INTERACTIVE = "INTERACTIVE"
    BACKGROUND = "BACKGROUND"


class CancelReason(str, Enum):
    USER_CANCELLED = "USER_CANCELLED"
    CONSENT_WITHDRAWN = "CONSENT_WITHDRAWN"
    TIMEOUT = "TIMEOUT"
    UPSTREAM_SHUTDOWN = "UPSTREAM_SHUTDOWN"
    SUPERSEDED = "SUPERSEDED"


class GenerationParameters(BaseModel):
    """服务端按白名单过滤，未知键丢弃（这里直接拒绝，防旁路配置）。"""

    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    temperature: Optional[float] = Field(default=None, ge=0, le=1.5)
    top_p: Optional[float] = Field(default=None, alias="topP", ge=0, le=1)
    max_output_tokens: Optional[int] = Field(default=None, alias="maxOutputTokens", ge=16, le=2048)


class TaskSubmitRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)

    tenant_id: str = Field(alias="tenantId", max_length=64)
    user_id: str = Field(alias="userId", max_length=64)
    task_type: TaskType = Field(alias="taskType")
    policy_version: str = Field(alias="policyVersion", max_length=40)
    trace_id: str = Field(alias="traceId", max_length=64)

    input_ref: Optional[str] = Field(default=None, alias="inputRef", max_length=256)
    input_inline: Optional[str] = Field(default=None, alias="inputInline", max_length=2000)
    voice: Optional[str] = Field(default=None, max_length=64)
    locale: Optional[str] = Field(default=None, max_length=20)
    requested_profile: Optional[ModelProfile] = Field(default=None, alias="requestedProfile")
    priority: Priority = Priority.INTERACTIVE
    generation_parameters: Optional[GenerationParameters] = Field(default=None, alias="generationParameters")

    @model_validator(mode="after")
    def _check_input_shape(self) -> "TaskSubmitRequest":
        if self.input_ref is not None and self.input_inline is not None:
            raise ValueError("inputRef 与 inputInline 只能二选一")
        return self


class CancelRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    reason: Optional[CancelReason] = None
