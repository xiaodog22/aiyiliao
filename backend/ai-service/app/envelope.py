"""统一信封与错误构造。

对齐契约：
- 成功信封 Envelope   {code:"OK", message, requestId, serverTime, meta?, data}
- 错误响应 ErrorResponse {code, message, requestId, retryable, traceId?, dependency?, serverTime}
- 探针（live/ready）**不走信封**，直接返回 ProbeResult / ReadinessResult。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Optional


def now_iso() -> str:
    """UTC ISO-8601（毫秒精度，Z 结尾）。"""
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
    retryable: bool,
    dependency: Optional[str] = None,
    trace_id: Optional[str] = None,
    details: Optional[list] = None,
) -> dict:
    body: dict = {
        "code": code,
        "message": message,
        "requestId": request_id,
        "retryable": retryable,
        "serverTime": now_iso(),
    }
    if dependency is not None:
        body["dependency"] = dependency
    if trace_id is not None:
        body["traceId"] = trace_id
    if details is not None:
        body["details"] = details
    return body


class ApiError(Exception):
    """业务/协议错误：由全局异常处理器统一转成 ErrorResponse。"""

    def __init__(
        self,
        http_status: int,
        code: str,
        message: str,
        retryable: bool = False,
        dependency: Optional[str] = None,
        details: Optional[list] = None,
    ) -> None:
        super().__init__(message)
        self.http_status = http_status
        self.code = code
        self.message = message
        self.retryable = retryable
        self.dependency = dependency
        self.details = details


def bad_request(message: str) -> ApiError:
    return ApiError(400, "BAD_REQUEST", message, retryable=False)


def unauthorized(message: str = "服务令牌无效") -> ApiError:
    return ApiError(401, "UNAUTHORIZED", message, retryable=False)


def not_found(message: str = "任务不存在") -> ApiError:
    return ApiError(404, "NOT_FOUND", message, retryable=False)


def idempotency_conflict(message: str = "相同幂等键提交了不同载荷") -> ApiError:
    return ApiError(409, "IDEMPOTENCY_CONFLICT", message, retryable=False)


def validation_failed(message: str, details: Optional[list] = None) -> ApiError:
    return ApiError(422, "VALIDATION_FAILED", message, retryable=False, details=details)


def queue_full(message: str = "队列已满，请稍后重试") -> ApiError:
    return ApiError(429, "QUEUE_FULL", message, retryable=True)


def dependency_unavailable(message: str, dependency: Optional[str] = None) -> ApiError:
    return ApiError(503, "DEPENDENCY_UNAVAILABLE", message, retryable=True, dependency=dependency)
