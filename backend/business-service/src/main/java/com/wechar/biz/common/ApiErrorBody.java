package com.wechar.biz.common;

import java.time.Instant;

/**
 * 统一错误信封（契约 ApiError，business-openapi.yaml components.schemas.ApiError）。
 * code 为稳定错误码，客户端据此分支；message 为面向用户的中文说明，不含堆栈/SQL/内网地址。
 */
public record ApiErrorBody(
        String code,
        String message,
        String requestId,
        Object details,
        boolean retryable,
        Instant serverTime
) {
}
