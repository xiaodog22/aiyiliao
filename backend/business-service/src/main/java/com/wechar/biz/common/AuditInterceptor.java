package com.wechar.biz.common;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.HandlerInterceptor;
import org.springframework.web.servlet.HandlerMapping;

/**
 * M4 审计拦截器：在请求完成后落一条 audit_events（见 {@link AuditLog}）。
 *
 * 记录判断（afterCompletion 阶段，此时状态码已定）：
 *  - 写方法（POST/PUT/PATCH/DELETE）→ 全记录（含成功），对应 docs/v4/03「谁在何时对哪类对象执行何动作」；
 *  - 读方法 → 仅非 2xx 记录（鉴权拒绝/越权 404 等安全证据）。
 *
 * action 取 handler 的路径模板（BEST_MATCHING_PATTERN_ATTRIBUTE，如
 * /api/v1/consents/{purpose}/withdraw），而非具体 URI —— 避免把对象 ID
 * 当作无界键值灌进 action 列；具体对象归属由业务表与已有事件表（如
 * appointment_status_events）承载，audit_events 只做对象类目级留痕。
 *
 * 无 handler（如 501 未实现路径）时用原始 URI 且**截断并去参数**，仍不记请求体。
 */
@Component
public class AuditInterceptor implements HandlerInterceptor {

    private final AuditLog auditLog;

    public AuditInterceptor(AuditLog auditLog) {
        this.auditLog = auditLog;
    }

    @Override
    public void afterCompletion(HttpServletRequest request, HttpServletResponse response,
                                Object handler, Exception ex) {
        if (!auditLog.enabled()) {
            return;
        }
        String method = request.getMethod();
        int status = response.getStatus();
        boolean write = isWrite(method);
        if (!write && status >= 200 && status < 300) {
            return; // 只读成功不记录
        }
        String pattern = pattern(request, handler, method);
        auditLog.record(
                actor(request),
                method + " " + pattern,
                objectType(pattern),
                status,
                requestId(request),
                clientIp(request));
    }

    private static boolean isWrite(String method) {
        return "POST".equals(method) || "PUT".equals(method)
                || "PATCH".equals(method) || "DELETE".equals(method);
    }

    private static String pattern(HttpServletRequest request, Object handler, String method) {
        Object attr = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        if (attr instanceof String p && !p.isBlank()) {
            return p;
        }
        if (handler instanceof HandlerMethod) {
            // 已命中 handler 却无模板属性（异常兜底路径）→ 用 URI 去参数
            return stripQuery(request.getRequestURI());
        }
        return stripQuery(request.getRequestURI());
    }

    private static String stripQuery(String uri) {
        String noQuery = uri.contains("?") ? uri.substring(0, uri.indexOf('?')) : uri;
        return noQuery.length() > 160 ? noQuery.substring(0, 160) : noQuery;
    }

    /** 对象类目 = /api/v1/ 之后的首段（无则用 "root"），保证列值有界、可索引。 */
    static String objectType(String pattern) {
        String p = pattern;
        int idx = p.indexOf("/api/v1/");
        if (idx >= 0) {
            p = p.substring(idx + "/api/v1/".length());
        }
        int slash = p.indexOf('/');
        String seg = slash >= 0 ? p.substring(0, slash) : p;
        return seg.isBlank() ? "root" : seg;
    }

    private static String actor(HttpServletRequest request) {
        // 拦截器认证结果（AuthInterceptor 写入）；匿名时为 null
        Object u = request.getAttribute(AuthInterceptor.AUTH_USER_ATTR);
        return u instanceof String id && !id.isBlank() ? id : null;
    }

    private static String requestId(HttpServletRequest request) {
        Object id = request.getAttribute(RequestIdFilter.ATTR);
        return id instanceof String s && !s.isBlank() ? s : null;
    }

    private static String clientIp(HttpServletRequest request) {
        String ip = request.getRemoteAddr();
        return ip == null || ip.isBlank() ? null : (ip.length() > 64 ? ip.substring(0, 64) : ip);
    }
}
