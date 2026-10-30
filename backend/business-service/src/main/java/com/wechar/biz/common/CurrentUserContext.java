package com.wechar.biz.common;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Optional;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 当前用户解析。M4 起身份一律以 AuthInterceptor 认证结果（请求属性）为权威：
 *  1. AUTH_USER_ATTR（拦截器按 app.auth.mode 认证后写入：strict=仅会话 Bearer；
 *     header=开发档 X-User-Id；off=不拦截，本方法回退旧占位解析）；
 *  2. off 模式回退旧顺序：X-User-Id → Bearer 会话 → 历史 openid 兜底 → dev 默认用户。
 * 范围过滤一律以这里的 userId 为准，不接受客户端传 patientId。
 */
@Component
public class CurrentUserContext {

    public static final String HEADER_USER_ID = "X-User-Id";
    public static final String HEADER_AUTHORIZATION = "Authorization";
    public static final String DEV_DEFAULT_USER = "dev-user-1";
    private static final String ACCESS_PREFIX = "at-";

    private final AuthSessionStore authSessionStore;

    public CurrentUserContext(AuthSessionStore authSessionStore) {
        this.authSessionStore = authSessionStore;
    }

    /** 当前请求的用户 ID（永为非空；无上下文时返回 dev 默认用户）。 */
    public String currentUserId() {
        return resolveUserId().orElse(DEV_DEFAULT_USER);
    }

    /** 当前用户 ID；拦截器认证结果优先，off 模式回退占位解析。无任何来源时 empty。 */
    public Optional<String> resolveUserId() {
        HttpServletRequest request = currentRequest();
        if (request == null) {
            return Optional.empty();
        }
        Object authed = request.getAttribute(AuthInterceptor.AUTH_USER_ATTR);
        if (authed instanceof String id && !id.isBlank()) {
            return Optional.of(id);
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
            // 历史联调方式：token 即 openid
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
