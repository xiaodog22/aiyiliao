package com.wechar.biz.common;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * M4 限流（08B §M4「限流」+ docs/v4/03 §145「对登录、上传、AI 提交、导出单独限流」）。
 *
 * 契约对齐：只拦 business-openapi 声明 '429' 的路径（登录/刷新、N9 短信下发、N8 账号登录、
 * 预约创建、家庭邀请、会话与消息、AI 提交、导诊急症、care-plan、ASR/TTS/音色预览）；
 * 未声明 429 的路径不受影响（不发明契约外语义）。
 *
 * 与网关限流（D 侧，默认关）分层：网关保护上游（全路径粗粒度），
 * 本层保护业务资源（敏感端点细粒度 + 身份维度），两者错误口径一致
 * （code=RATE_LIMITED、retryable=true、Retry-After 秒数，见 edge-gateway/ratelimit.py）。
 *
 * 算法：固定窗口（低配无 Redis，进程内存即可；单实例部署见 docs/v4/05）。
 * 键：登录/刷新按 IP（匿名、防撞库）；其余按认证主体（防单用户刷 AI 提交）。
 * 默认阈值从宽（login 30/min/IP、submit 60/min/主体），生产用环境变量收紧；
 * app.rate-limit.enabled=false 整体关闭（回滚阀）。
 *
 * 命中 → 直接写 429 统一信封 + Retry-After（不再进入 handler）；
 * afterCompletion 不适用（preHandle 返回 false），审计由先行的 audit 拦截器记录。
 */
@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    /** 声明 429 的契约路径（method + path pattern → 组别）。 */
    private static final Map<String, String> LIMITS = Map.ofEntries(
            Map.entry("POST /api/v1/auth/wechat/login", "login"),
            Map.entry("POST /api/v1/auth/refresh", "login"),
            // N8/N9（2026-10-19）：登录端点族按 IP 限流（匿名端点，无认证主体可用）
            Map.entry("POST /api/v1/auth/sms/send", "login"),
            Map.entry("POST /api/v1/doctor/login", "login"),
            Map.entry("POST /api/v1/doctor/login-by-account", "login"),
            Map.entry("POST /api/v1/appointments", "submit"),
            Map.entry("POST /api/v1/family-members/invitations", "submit"),
            Map.entry("POST /api/v1/consultations", "submit"),
            Map.entry("POST /api/v1/consultations/*/messages", "submit"),
            Map.entry("POST /api/v1/triage/emergency-checks", "submit"),
            Map.entry("POST /api/v1/care-plans", "submit"),
            Map.entry("POST /api/v1/voice/asr", "submit"),
            Map.entry("POST /api/v1/voice/tts", "submit"),
            Map.entry("POST /api/v1/voice/voices/*/previews", "submit"));

    /** 按键的固定窗口计数：key → [窗口起始秒, 计数]。 */
    private record Window(long startSecond, AtomicInteger count) {
    }

    private final Map<String, Window> windows = new ConcurrentHashMap<>();
    private final boolean enabled;
    private final int windowSeconds;
    private final int loginPerWindow;
    private final int submitPerWindow;

    public RateLimitInterceptor(
            @Value("${app.rate-limit.enabled:true}") boolean enabled,
            @Value("${app.rate-limit.window-seconds:60}") int windowSeconds,
            @Value("${app.rate-limit.login-per-window:30}") int loginPerWindow,
            @Value("${app.rate-limit.submit-per-window:60}") int submitPerWindow) {
        this.enabled = enabled;
        this.windowSeconds = Math.max(1, windowSeconds);
        this.loginPerWindow = Math.max(1, loginPerWindow);
        this.submitPerWindow = Math.max(1, submitPerWindow);
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler)
            throws Exception {
        if (!enabled) {
            return true;
        }
        String group = LIMITS.get(request.getMethod() + " " + template(request));
        if (group == null) {
            return true; // 未声明 429 的路径不拦
        }
        String key = group + "|" + ("login".equals(group) ? clientIp(request) : actor(request));
        String windowKey = key + "@" + (System.currentTimeMillis() / 1000 / windowSeconds);
        Window w = windows.computeIfAbsent(windowKey, k -> new Window(
                System.currentTimeMillis() / 1000 / windowSeconds, new AtomicInteger(0)));
        int used = w.count().incrementAndGet();
        cleanup(windowKey);
        int limit = "login".equals(group) ? loginPerWindow : submitPerWindow;
        if (used > limit) {
            long nowSecond = System.currentTimeMillis() / 1000;
            long windowStart = w.startSecond() * windowSeconds;
            int retryAfter = (int) Math.max(1, windowStart + windowSeconds - nowSecond);
            write429(response, retryAfter, request);
            return false;
        }
        return true;
    }

    private static String template(HttpServletRequest request) {
        Object attr = request.getAttribute(
                org.springframework.web.servlet.HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
        String pattern = attr instanceof String p && !p.isBlank() ? p : request.getRequestURI();
        int q = pattern.indexOf('?');
        return q >= 0 ? pattern.substring(0, q) : pattern;
    }

    private String actor(HttpServletRequest request) {
        Object u = request.getAttribute(AuthInterceptor.AUTH_USER_ATTR);
        String id = u instanceof String s && !s.isBlank() ? s : null;
        return id != null ? id : clientIp(request); // 匿名受保护路径极少见（auth 先 401），兜底按 IP
    }

    private String clientIp(HttpServletRequest request) {
        String ip = request.getRemoteAddr();
        return ip == null || ip.isBlank() ? "unknown" : ip;
    }

    /** 只清当前键之外的过期窗口（避免无界增长）；低配环境单键粒度足够。 */
    private void cleanup(String currentKey) {
        if (windows.size() <= 10_000) {
            return;
        }
        long now = System.currentTimeMillis() / 1000 / windowSeconds;
        windows.entrySet().removeIf(e -> !e.getKey().equals(currentKey)
                && e.getValue().startSecond() < now - 1);
    }

    /** 429 统一信封（与 GlobalExceptionHandler.ApiErrorBody 同形状）+ Retry-After。 */
    private void write429(HttpServletResponse response, int retryAfter, HttpServletRequest request)
            throws java.io.IOException {
        String requestId = request.getAttribute(RequestIdFilter.ATTR) instanceof String r ? r : null;
        String body = "{\"code\":\"RATE_LIMITED\",\"message\":\"请求过于频繁，请稍后重试\","
                + "\"requestId\":" + jsonOrNull(requestId)
                + ",\"details\":null,\"retryable\":true,"
                + "\"serverTime\":\"" + java.time.Instant.now() + "\"}";
        response.setStatus(429);
        response.setHeader("Retry-After", String.valueOf(retryAfter));
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        response.setCharacterEncoding(StandardCharsets.UTF_8.name());
        response.getWriter().write(body);
    }

    private static String jsonOrNull(String v) {
        return v == null ? "null" : "\"" + v.replace("\"", "\\\"") + "\"";
    }
}
