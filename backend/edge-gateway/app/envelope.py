"""统一信封（business-openapi.yaml 的 EnvelopeBase / ApiError 形状）。"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def new_request_id() -> str:
    return "r_" + uuid.uuid4().hex[:16]


def ok_envelope(request_id: str, data: Any, message: str = "OK", meta: Optional[dict] = None) -> dict:
    body: dict = {
        "code": "OK",
        "message": message,
        "requestId": request_id,
        "serverTime": now_iso(),
        "data": data,
    }
    if meta is not None:
        body["meta"] = meta
    return body


def error_payload(
    code: str,
    message: str,
    request_id: str,
    retryable: bool = False,
    details: Optional[list] = None,
) -> dict:
    body: dict = {
        "code": code,
        "message": message,
        "requestId": request_id,
        "retryable": retryable,
        "serverTime": now_iso(),
    }
    if details is not None:
        body["details"] = details
    return body


class ApiError(Exception):
    def __init__(
        self,
        http_status: int,
        code: str,
        message: str,
        retryable: bool = False,
        details: Optional[list] = None,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.details = details


def upstream_unavailable(message: str = "业务服务暂不可达，请稍后重试") -> ApiError:
    return ApiError(503, "UPSTREAM_UNAVAILABLE", message, retryable=True)


def upstream_timeout(message: str = "上游响应超时") -> ApiError:
    return ApiError(504, "UPSTREAM_TIMEOUT", message, retryable=True)


def upstream_error(message: str = "上游异常") -> ApiError:
    return ApiError(502, "UPSTREAM_ERROR", message, retryable=True)


def compat_pending(milestone: str, note: str, blockers: Optional[list] = None) -> ApiError:
    """旧路径未完成迁移（501）。

    `blockers` 为该条「不可等价转发」的技术原因清单（可选）——随 details 返回，
    供联调方定位为何不能自动翻译；不回填缺失字段、不伪造数据。
    """
    details = (
        [{"field": "compat", "reason": str(b), "code": "COMPAT_BLOCKER"} for b in blockers]
        if blockers
        else None
    )
    return ApiError(
        501,
        "COMPAT_PENDING",
        f"该旧路径尚未完成迁移（计划 {milestone}）：{note}",
        retryable=False,
        details=details,
    )


def compat_dropped(note: str) -> ApiError:
    return ApiError(410, "COMPAT_DROPPED", f"该旧路径已废弃：{note}", retryable=False)


def not_found(message: str = "路径不存在") -> ApiError:
    return ApiError(404, "NOT_FOUND", message, retryable=False)


def unauthorized(message: str = "未登录或登录态无效") -> ApiError:
    return ApiError(401, "UNAUTHORIZED", message, retryable=False)
