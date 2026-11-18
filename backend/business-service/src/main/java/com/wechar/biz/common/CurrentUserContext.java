package com.wechar.biz.common;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 当前用户解析。M4 起身份一律以 AuthInterceptor 认证结果（请求属性）为权威：
 *  1. AUTH_USER_ATTR（拦截器按 app.auth.mode 认证后写入：strict=仅会话 Bearer；
 *     header=开发档 X-User-Id；off=不拦截，本方法回退旧占位解析）；
 *  2. off/header 模式才回退旧顺序：X-User-Id → Bearer 会话 → 历史 openid 兜底。
 *
 * <p>2026-11-18（审计 H3）：strict 档删除全部回退 —— 匿名白名单路径（/auth/sms/send、
 * /contents、/triage/emergency-checks、/attachments/* 等）不经过认证，若仍采信
 * {@code X-User-Id} 或"非 at- 前缀令牌即 openid"，任何调用方都能在这些路径上自报身份。
 * 当前它们恰好不消费身份，但这是"端点恰好不用"的偶然条件，不能当防线。
 * strict 下 {@link #currentUserId()} 无上下文时抛 401，而不是兜底 dev-user-1。</p>
 *
 * 范围过滤一律以这里的 userId 为准，不接受客户端传 patientId。
 */
@Component
public class CurrentUserContext {

    public static final String HEADER_USER_ID = "X-User-Id";
    public static final String HEADER_AUTHORIZATION = "Authorization";
    public static final String DEV_DEFAULT_USER = "dev-user-1";
    private static final String ACCESS_PREFIX = "at-";

    private final AuthSessionStore authSessionStore;

    /** 鉴权模式（与 AuthInterceptor 同源）：strict 档不再做任何客户端身份回退。 */
    private final AuthInterceptor.Mode mode;

    public CurrentUserContext(AuthSessionStore authSessionStore,
                              @Value("${app.auth.mode:strict}") String mode) {
        this.authSessionStore = authSessionStore;
        this.mode = AuthInterceptor.parse(mode);
    }

    /**
     * 当前请求的用户 ID。无身份即 401（strict/header 档），不再返回 dev 默认用户。
     *
     * <p>off 档保留历史占位语义（离线联调/单测直接跑业务方法），但仅限该档。</p>
     */
    public String currentUserId() {
        return resolveUserId().orElseGet(() -> {
            if (mode == AuthInterceptor.Mode.OFF) {
                return DEV_DEFAULT_USER;
            }
            throw new ApiException("UNAUTHORIZED", HttpStatus.UNAUTHORIZED, "登录状态已失效，请重新登录");
        });
    }

    /** 当前用户 ID；拦截器认证结果优先，非 strict 档才回退占位解析。无任何来源时 empty。 */
    public Optional<String> resolveUserId() {
        HttpServletRequest request = currentRequest();
        if (request == null) {
            return Optional.empty();
        }
        Object authed = request.getAttribute(AuthInterceptor.AUTH_USER_ATTR);
        if (authed instanceof String id && !id.isBlank()) {
            return Optional.of(id);
        }
        if (mode == AuthInterceptor.Mode.STRICT) {
            // 严格档：只有拦截器认证结果算身份；客户端自报头/裸令牌一律不采信
            return Optional.empty();
        }
        String headerUser = request.getHeader(HEADER_USER_ID);
        if (headerUser != null && !headerUser.isBlank()) {
            return Optional.of(headerUser.trim());
        }
        String auth = request.getHeader(HEADER_AUTHORIZATION);
        if (auth != null && auth.startsWith("Bearer ")) {
            String token = auth.substring("Bearer ".length()).trim();
            if (token.isEmpty()) {
                return Optional.empty();
            }
            // 已签发的 access token：以会话表为权威
            Optional<String> bySession = authSessionStore.resolveUserByAccessToken(token);
            if (bySession.isPresent()) {
                return bySession;
            }
            // at- 前缀但未命中 = 过期/已撤销/伪造：不回退为 openid、不建用户
            if (token.startsWith(ACCESS_PREFIX)) {
                return Optional.empty();
            }
            // 历史联调方式：token 即 openid（仅非 strict 档）
            return Optional.of(token);
        }
        return Optional.empty();
    }

    private HttpServletRequest currentRequest() {
        return Optional.ofNullable(RequestContextHolder.getRequestAttributes())
                .filter(attrs -> attrs instanceof ServletRequestAttributes)
                .map(attrs -> ((ServletRequestAttributes) attrs).getRequest())
                .orElse(null);
    }
}
