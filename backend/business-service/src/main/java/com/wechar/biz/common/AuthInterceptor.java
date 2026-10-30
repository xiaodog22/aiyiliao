package com.wechar.biz.common;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * M4 鉴权收口拦截器（08B §M4「鉴权/授权」+ docs/v4/06 §8 SEC-01/02/06）。
 *
 * 背景：M1 为占位鉴权（不强制 401，CurrentUserContext 无 token 兜底 dev 用户），
 * 08B 明确「M1 不强制 401（鉴权硬化在 M4）」。本拦截器按契约 401 声明矩阵收口：
 *  - 契约声明了 401 且非 security:[] 的路径 = 受保护路径：无有效身份 → 401；
 *  - security:[] / 未声明 401 的路径 = 匿名可访问（登录、导诊急症、目录、科普、manifest、refresh）；
 *  - 已携带 Bearer 但会话无法解析（过期/撤销/伪造）→ 401 SESSION_REVOKED（唯一例外：
 *    logout 按"会话哈希存在即可"放行 —— 契约 logout 要求重复撤销幂等 200，已撤销链必须能再次调用）。
 *
 * 模式（app.auth.mode，回滚阀 = off 恢复 M1 占位行为）：
 *  - strict：仅会话 Bearer 可认证；**X-User-Id 被忽略**（生产默认，拒绝客户端自报身份）；
 *  - header：dev/itest 档，X-User-Id 仍作为开发身份源（真机 E2E 依赖），但无任何身份 → 401；
 *  - off：M1 占位（不拦截）。
 *
 * 401 经 ApiException → GlobalExceptionHandler 统一信封（code=UNAUTHORIZED / SESSION_REVOKED，
 * 与 edge-gateway envelope.unauthorized 的 UNAUTHORIZED 对齐；前端 request.js 按 HTTP 401 触发刷新）。
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    public enum Mode { OFF, HEADER, STRICT }

    /** 由拦截器认证后的主体（写入请求属性，CurrentUserContext 优先读取）。 */
    public static final String AUTH_USER_ATTR = "com.wechar.biz.auth.user";

    private static final String BEARER = "Bearer ";

    /**
     * 匿名可访问路径（契约矩阵：未声明 401 或 security:[]）。
     * 路径为 Ant 模式；方法随路径固定。任务书别名路径按同语义归入
     * （/api/v1/doctors = /departments/{id}/doctors 的目录别名；emergency-check 同 emergency-checks）。
     */
    private static final Map<String, String> ANONYMOUS = Map.ofEntries(
            Map.entry("/api/v1/auth/wechat/login", "POST"),
            Map.entry("/api/v1/auth/refresh", "POST"),
            // N9（2026-10-19）：短信验证码下发在登录之前，必须匿名可访问（限流见 RateLimitInterceptor）
            Map.entry("/api/v1/auth/sms/send", "POST"),
            Map.entry("/api/v1/doctor/login", "POST"),
            // N8（2026-10-19）：工号/手机号+验证码登录（登录端点族，匿名）
            Map.entry("/api/v1/doctor/login-by-account", "POST"),
            Map.entry("/api/v1/departments", "GET"),
            // N7（2026-10-19）：院区列表，与科室/医生同为匿名只读目录
            Map.entry("/api/v1/hospitals", "GET"),
            Map.entry("/api/v1/departments/*/doctors", "GET"),
            Map.entry("/api/v1/doctors", "GET"),
            Map.entry("/api/v1/doctors/*/slots", "GET"),
            // V22（2026-10-22）：医生在线可用性，患者侧只读（契约 security:[]，与 /slots 同口径）
            Map.entry("/api/v1/doctors/*/availability", "GET"),
            Map.entry("/api/v1/triage/emergency-check", "POST"),
            Map.entry("/api/v1/triage/emergency-checks", "POST"),
            Map.entry("/api/v1/contents", "GET"),
            Map.entry("/api/v1/contents/*", "GET"),
            // N12/N13（2026-10-19）：健康科普（匿名只读，与 contents 同口径；契约未声明 401）
            Map.entry("/api/v1/health-articles", "GET"),
            Map.entry("/api/v1/health-articles/*", "GET"),
            // 资源清单 + 资源流式读取（V14）：<image>/wx.downloadFile 无法携带 Authorization，
            // 且清单与图片均为公开只读元数据/素材（只返回 status=1）。单段 * 同时覆盖
            // /manifest 与 /{key}，故删除原先单独的 manifest 条目（Map key 唯一，不能并存）。
            Map.entry("/api/v1/resources/*", "GET"),
            // N17（2026-10-19）：院内导航楼层与路径规划，匿名只读（契约未声明 401）
            Map.entry("/api/v1/indoor-map/floors", "GET"),
            Map.entry("/api/v1/indoor-map/route", "GET"),
            // 头像公开读取（V8）：<image> 组件直连无法携带 Authorization；文件名服务端生成
            Map.entry("/api/v1/avatars/*", "GET"),
            // 附件公开读取（V9）：同上，且 URL 带 HMAC 短期签名（expires+sig），无签名 403
            Map.entry("/api/v1/attachments/*", "GET"),
            // dev 档演示管理（2026-10-24）：号源一键重置；仅 dev profile 注册 Controller，
            // 生产环境无此端点，白名单条目安全（生产路径 404）
            Map.entry("/api/v1/dev/slots/status", "GET"),
            Map.entry("/api/v1/dev/slots/reset", "POST"),
            Map.entry("/api/v1/dev/admin", "GET"));

    private final AuthSessionStore authSessionStore;
    private final Mode mode;

    public AuthInterceptor(AuthSessionStore authSessionStore,
                           @Value("${app.auth.mode:strict}") String mode) {
        this.authSessionStore = authSessionStore;
        this.mode = parse(mode);
    }

    static Mode parse(String raw) {
        if (raw == null) {
            return Mode.STRICT;
        }
        return switch (raw.trim().toLowerCase()) {
            case "off" -> Mode.OFF;
            case "header" -> Mode.HEADER;
            default -> Mode.STRICT;
        };
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (mode == Mode.OFF) {
            return true; // M1 占位回滚阀
        }
        String bearer = bearerToken(request);
        if (bearer != null) {
            var session = authSessionStore.resolveUserByAccessToken(bearer);
            if (session.isPresent()) {
                request.setAttribute(AUTH_USER_ATTR, session.get());
                return true;
            }
            // 令牌无法解析：匿名路径忽略它（登录/刷新时携带陈旧令牌不阻断重登）；
            // logout 按"哈希存在"放行（重复撤销幂等 200）；其余受保护路径 → 401。
            if (isAnonymous(request)) {
                return true;
            }
            if (isLogout(request) && authSessionStore.sessionHashExists(bearer)) {
                request.setAttribute(AUTH_USER_ATTR,
                        authSessionStore.resolveUserAnyState(bearer).orElse(null));
                return true;
            }
            throw new ApiException("SESSION_REVOKED", HttpStatus.UNAUTHORIZED,
                    "访问令牌无效、已过期或已撤销，请重新登录");
        }
        String headerUser = request.getHeader(CurrentUserContext.HEADER_USER_ID);
        if (headerUser != null && !headerUser.isBlank() && mode == Mode.HEADER) {
            request.setAttribute(AUTH_USER_ATTR, headerUser.trim()); // dev/itest 开发身份源
            return true;
        }
        if (isAnonymous(request)) {
            return true;
        }
        throw new ApiException("UNAUTHORIZED", HttpStatus.UNAUTHORIZED, "未登录或登录态无效");
    }

    private boolean isAnonymous(HttpServletRequest request) {
        String path = request.getRequestURI();
        // HEAD 是 GET 的安全变体（同一资源、无响应体）：匿名只读路径必须一并放行，
        // 否则 curl -I / 缓存/探活探测会被打成 401（V14 资源端点验收实测踩到）。
        // 注意只做 HEAD→GET 单向映射：GET 条目不会因此放行任何写方法。
        String method = "HEAD".equals(request.getMethod()) ? "GET" : request.getMethod();
        return ANONYMOUS.entrySet().stream()
                .anyMatch(e -> e.getValue().equals(method) && match(e.getKey(), path));
    }

    private boolean isLogout(HttpServletRequest request) {
        return "POST".equals(request.getMethod())
                && request.getRequestURI().endsWith("/api/v1/auth/logout");
    }

    private static String bearerToken(HttpServletRequest request) {
        String auth = request.getHeader(CurrentUserContext.HEADER_AUTHORIZATION);
        if (auth != null && auth.startsWith(BEARER)) {
            String token = auth.substring(BEARER.length()).trim();
            return token.isEmpty() ? null : token;
        }
        return null;
    }

    /** 极简 Ant 匹配：仅支持单段 * 通配（本表所需形状）。 */
    private static boolean match(String pattern, String path) {
        String[] p = pattern.split("/");
        String[] a = path.split("/");
        if (p.length != a.length) {
            return false;
        }
        for (int i = 0; i < p.length; i++) {
            if (!p[i].equals(a[i]) && !"*".equals(p[i])) {
                return false;
            }
        }
        return true;
    }

    @SuppressWarnings("unused")
    private static final Set<String> UNUSED = Set.of(); // 保留位（表型扩展点）
}
