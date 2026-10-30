package com.wechar.biz.common;

import org.springframework.http.HttpStatus;

/**
 * 业务异常：携带稳定错误码 + HTTP 状态 + 是否可重试，由 GlobalExceptionHandler
 * 统一转为契约 ApiError 信封。禁止在 Controller 之外直接写 HTTP 响应。
 */
public class ApiException extends RuntimeException {

    private final String code;
    private final HttpStatus status;
    private final boolean retryable;
    private final Object details;

    public ApiException(String code, HttpStatus status, String message) {
        this(code, status, message, false, null);
    }

    public ApiException(String code, HttpStatus status, String message, boolean retryable, Object details) {
        super(message);
        this.code = code;
        this.status = status;
        this.retryable = retryable;
        this.details = details;
    }

    public String getCode() { return code; }
    public HttpStatus getStatus() { return status; }
    public boolean isRetryable() { return retryable; }
    public Object getDetails() { return details; }
}
