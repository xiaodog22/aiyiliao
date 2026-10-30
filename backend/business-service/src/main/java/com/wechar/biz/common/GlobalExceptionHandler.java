package com.wechar.biz.common;

import jakarta.servlet.http.HttpServletRequest;
import java.time.Instant;
import java.util.List;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MissingRequestHeaderException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.NoHandlerFoundException;

/**
 * 统一错误处理：所有异常都转为契约 ApiError 信封。
 * 红线（总纲 §9-5）：严禁 200 + 空对象、静默吞错；未实现路径必须返回可识别错误。
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /** 业务异常：按携带的码与状态输出。 */
    @ExceptionHandler(ApiException.class)
    public ResponseEntity<ApiErrorBody> handleApi(ApiException ex, HttpServletRequest req) {
        return build(ex.getStatus(), ex.getCode(), ex.getMessage(), ex.isRetryable(), ex.getDetails(), req);
    }

    /** 契约级校验失败（422）：Bean Validation 逐字段说明。 */
    @ExceptionHandler(org.springframework.web.bind.MethodArgumentNotValidException.class)
    public ResponseEntity<ApiErrorBody> handleValidation(
            org.springframework.web.bind.MethodArgumentNotValidException ex, HttpServletRequest req) {
        var details = ex.getBindingResult().getFieldErrors().stream()
                .map(fe -> new ErrorDetail(fe.getField(), fe.getDefaultMessage(), "INVALID"))
                .toList();
        return build(HttpStatus.UNPROCESSABLE_ENTITY, "VALIDATION_FAILED",
                "请求参数未通过校验", false, details, req);
    }

    /** 请求体不可读（JSON 格式错）→ 400。 */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ApiErrorBody> handleUnreadable(HttpServletRequest req) {
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "请求体格式错误", false, null, req);
    }

    /** 缺必填请求头（如契约 required 的 X-Client-Version）→ 400。 */
    @ExceptionHandler(MissingRequestHeaderException.class)
    public ResponseEntity<ApiErrorBody> handleMissingHeader(MissingRequestHeaderException ex, HttpServletRequest req) {
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST",
                "缺少必需请求头 " + ex.getHeaderName(), false, null, req);
    }

    /** 缺必填查询参数（如附件签名 URL 的 expires/sig）→ 400，不落 500。 */
    @ExceptionHandler(org.springframework.web.bind.MissingServletRequestParameterException.class)
    public ResponseEntity<ApiErrorBody> handleMissingParam(
            org.springframework.web.bind.MissingServletRequestParameterException ex, HttpServletRequest req) {
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST",
                "缺少必需参数 " + ex.getParameterName(), false, null, req);
    }

    /** 路径/查询参数类型不匹配 → 400。 */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    public ResponseEntity<ApiErrorBody> handleMismatch(HttpServletRequest req) {
        return build(HttpStatus.BAD_REQUEST, "BAD_REQUEST", "请求参数取值错误", false, null, req);
    }

    /** 路径存在但方法不匹配（如契约只有 POST 的路径来了 GET）→ 405，不落 500。 */
    @ExceptionHandler(org.springframework.web.HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ApiErrorBody> handleMethodNotSupported(HttpServletRequest req) {
        return build(HttpStatus.METHOD_NOT_ALLOWED, "METHOD_NOT_ALLOWED",
                "该接口不支持 " + req.getMethod() + " 方法", false, null, req);
    }

    /** 未实现端点（M0.4）：可识别的"未实现"，绝不空 200、不静默。Spring 6.2 抛 NoHandlerFoundException。 */
    @ExceptionHandler(NoHandlerFoundException.class)
    public ResponseEntity<ApiErrorBody> handleNoHandler(HttpServletRequest req) {
        return build(HttpStatus.NOT_IMPLEMENTED, "NOT_IMPLEMENTED",
                "该接口尚未实现（进度见 backend/business-service/README.md）", false, null, req);
    }

    /** 兜底：未预期异常 → 500，记录原始异常，响应不带堆栈。 */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ApiErrorBody> handleUnexpected(Exception ex, HttpServletRequest req) {
        log.error("未预期异常 method={} path={}", req.getMethod(), req.getRequestURI(), ex);
        return build(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL_ERROR",
                "服务内部错误，请稍后重试（可提供 requestId）", true, null, req);
    }

    private ResponseEntity<ApiErrorBody> build(HttpStatus status, String code, String message,
                                               boolean retryable, Object details, HttpServletRequest req) {
        String requestId = (String) req.getAttribute(RequestIdFilter.ATTR);
        ApiErrorBody body = new ApiErrorBody(code, message, requestId, details, retryable, Instant.now());
        return ResponseEntity.status(status).body(body);
    }

    /** 契约 ErrorDetail：仅 field/reason/code 三个字段，additionalProperties: false。 */
    public record ErrorDetail(String field, String reason, String code) {
    }
}
