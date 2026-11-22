package com.wechar.biz.auth;

import com.wechar.biz.common.ApiException;
import jakarta.servlet.http.HttpServletRequest;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashSet;
import java.util.Set;
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

    /** 联调密钥请求头（小程序 config/env.local.js 的 DEV_LOGIN_KEY 与此对应）。 */
    public static final String HEADER = "X-Dev-Login-Key";

    /**
     * 已泄露、永久失效的历史密钥（审计 C1 · 撤销式轮换）。
     *
     * <p>两个值都曾随公开仓库与 git 历史分发，视为**永久失效**：轮换只改变"当前值"，
     * 不能撤销已分发的副本，因此必须显式黑名单比对。默认值即历史值，
     * 可用 {@code app.auth.dev-login.revoked-keys}（逗号分隔）追加。</p>
     */
    static final String DEFAULT_REVOKED_KEYS =
            "wb-devlogin-21cbddfc3b21990d6df374f6fa3f92cc,wb-devlogin-281819dbbf8ade34e27ac5fb04ce48a6,"
                    + "wb-devlogin-e6a98a5b0c2712b344b077d87eb29035";

    private static final Logger log = LoggerFactory.getLogger(DevLoginGuard.class);

    private final boolean enabled;
    private final String key;
    /** 已撤销的历史密钥集合（命中即拒，含当前配置值 —— 配置成旧值会直接启动失败）。 */
    private final Set<String> revoked;

    public DevLoginGuard(@Value("${app.auth.dev-login.enabled:false}") boolean enabled,
                         @Value("${app.auth.dev-login.key:}") String key,
                         @Value("${app.auth.dev-login.revoked-keys:" + DEFAULT_REVOKED_KEYS + "}") String revokedKeys) {
        this.enabled = enabled;
        this.key = key == null ? "" : key.trim();
        this.revoked = parseKeys(revokedKeys);
        // 撤销式轮换（审计 C1）：旧值已随公开仓库分发，仅"换一个新值"不是撤销 ——
        // 若当前仍配置着已泄露的旧值，直接拒绝启动（fail-fast），避免把泄露值当成有效密钥。
        if (!this.key.isEmpty() && this.revoked.contains(this.key)) {
            throw new IllegalStateException(
                    "APP_AUTH_DEV_LOGIN_KEY 仍是已泄露的历史值，必须轮换后再启动（审计 C1）。");
        }
    }

    private static Set<String> parseKeys(String raw) {
        Set<String> keys = new LinkedHashSet<>();
        if (raw == null || raw.isBlank()) {
            return keys;
        }
        for (String part : raw.split(",")) {
            String trimmed = part.trim();
            if (!trimmed.isEmpty()) {
                keys.add(trimmed);
            }
        }
        return keys;
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
        // 双保险：即便配置侧漏改，历史泄露值也一律不再放行（旧包/旧脚本必须失效）
        if (this.revoked.contains(got.trim())) {
            log.error("拒绝 dev 派生 code（{}）：命中已撤销的历史密钥（审计 C1）", scene);
            throw forbidden("联调登录凭据已撤销，请更新到最新联调包。");
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
