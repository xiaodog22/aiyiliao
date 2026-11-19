"""统一业务异常。"""

from __future__ import annotations


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details=None, retryable: bool = False):
        super().__init__(message)
        self.status = int(status)
        self.code = code
        self.message = message
        self.details = details
        self.retryable = retryable


def bad_request(message: str, details=None, code: str = "VALIDATION_FAILED") -> ApiError:
    return ApiError(400, code, message, details)


def unauthorized(message: str = "登录状态已失效，请重新登录", code: str = "AUTH_REQUIRED") -> ApiError:
    return ApiError(401, code, message)


def forbidden(message: str = "无权限执行该操作", code: str = "FORBIDDEN") -> ApiError:
    return ApiError(403, code, message)


def not_found(message: str = "资源不存在", code: str = "NOT_FOUND") -> ApiError:
    return ApiError(404, code, message)


def conflict(message: str, code: str = "STATE_CONFLICT") -> ApiError:
    return ApiError(409, code, message)
