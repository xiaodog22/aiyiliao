package com.wechar.biz.auth;

import com.wechar.biz.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Profile;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * dev 档登录闸门（2026-10-29 · 后端 P0 加固第二道）。
 *
 * <p><b>要解决的问题</b>：{@link DevWechatSessionProvider} 只认 code 形态
 * （含 {@code dev-user-2} → 医生身份，其余 → 患者身份），不校验任何凭证。实例一旦经内网穿透
 * 暴露到公网，任何人 {@code curl -d '{"code":"dev-user-1"}'} 就能拿到真实会话——
 * 与小程序构建档位无关，属于服务端越权入口（测试报告 §0 只覆盖了前端侧）。</p>
 *
 * <p><b>本闸门的口径</b>（三道同时满足才放行 dev 派生 code）：</p>
 * <ol>
 *   <li>{@code app.auth.dev-login.enabled=true}（默认 <b>false</b>，必须显式开启）；</li>
 *   <li>{@code app.auth.dev-login.key} 非空（默认空 = 未配置，一律拒）；</li>
 *   <li>请求头 {@code X-Dev-Login-Key} 与之**恒定时间**相等。</li>
 * </ol>
 *
 * <p><b>为什么挂在 provider 而不是拦截器</b>：闸门只该管「dev 派生 code」这一件事，真实微信 code
 * 在生产档由 {@link ProdWechatSessionProvider} 处理，完全不受影响；挂在 provider 上也不会误伤
 * 匿名接口白名单、限流、审计等既有链路。</p>
 *
 * <p><b>itest 档不装配</b>（{@code @Profile("dev")}）：集成测试用 X-User-Id / 直接构造会话，
 * 不经过本闸门，既有 103+ 用例语义不变。</p>
 */
@Component
@Profile("dev")
public class DevLoginGuard {

    /** 联调密钥请求头（小程序 config/env.js 的 DEV_LOGIN_KEY 与此对应）。 */
    public static final String HEADER = "X-Dev-Login-Key";

    private static final Logger log = LoggerFactory.getLogger(DevLoginGuard.class);

    private final boolean enabled;
    private final String key;

    public DevLoginGuard(@Value("${app.auth.dev-login.enabled:false}") boolean enabled,
                         @Value("${app.auth.dev-login.key:}") String key) {
        this.enabled = enabled;
        this.key = key == null ? "" : key.trim();
    }

    /**
     * 校验本次请求是否允许使用 dev 派生 code；不通过直接抛 403（不签发任何会话）。
     * @param scene 场景名（login / phone），只用于日志定位，不含任何凭证
     */
    void assertAllowed(String scene) {
        if (!enabled) {
            log.warn("拒绝 dev 派生 code（{}）：联调登录未开启 APP_AUTH_DEV_LOGIN_ENABLED", scene);
            throw forbidden("当前环境未开启联调登录，请使用微信一键登录。");
        }
        if (this.key.isEmpty()) {
            log.warn("拒绝 dev 派生 code（{}）：未配置 APP_AUTH_DEV_LOGIN_KEY", scene);
            throw forbidden("联调登录密钥未配置，暂不可用。");
        }
        String got = header();
        if (got == null || !constantTimeEquals(got.trim(), this.key)) {
            log.warn("拒绝 dev 派生 code（{}）：{} 缺失或不匹配", scene, HEADER);
            throw forbidden("联调登录校验失败，请更新到最新联调包。");
        }
    }

    private static ApiException forbidden(String message) {
        // 错误码固定在契约外命名空间（DEV_ 前缀），便于前端 err-text 兜底成中文
        return new ApiException("DEV_LOGIN_FORBIDDEN", HttpStatus.FORBIDDEN, message);
    }

    private static String header() {
        try {
            ServletRequestAttributes attrs =
                    (ServletRequestAttributes) RequestContextHolder.getRequestAttributes();
            if (attrs == null) return null;
            HttpServletRequest req = attrs.getRequest();
            return req == null ? null : req.getHeader(HEADER);
        } catch (RuntimeException e) {
            // 非 Web 线程（无请求上下文）视为不通过：宁可拒绝，不静默放行
            return null;
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        return MessageDigest.isEqual(a.getBytes(StandardCharsets.UTF_8), b.getBytes(StandardCharsets.UTF_8));
    }
}
