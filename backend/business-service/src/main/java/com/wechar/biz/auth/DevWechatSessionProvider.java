package com.wechar.biz.auth;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.context.annotation.Profile;
import org.springframework.stereotype.Component;

/**
 * dev 档微信会话适配器：稳定假数据，不触网（README §启动接入契约已声明为开发档）。
 * 约定（供联调）：
 *   - code 含 "dev-user-2" → openid=dev-user-2；其余合法 code → openid=dev-user-1。
 *   - phoneCode 形如 dev-phone-13800001111 → 返回 13800001111；其余返回 null（令牌无效）。
 * 生产（非 dev profile）严禁启用本实现。
 *
 * ⚠️ 2026-10-29 加固：dev 派生 code **不再无条件接受**。dev 档必须同时配置
 *    APP_AUTH_DEV_LOGIN_ENABLED=true 与 APP_AUTH_DEV_LOGIN_KEY，并在请求头带
 *    X-Dev-Login-Key —— 否则 403 DEV_LOGIN_FORBIDDEN（见 {@link DevLoginGuard}）。
 *    背景：隧道暴露时任何人都能用 code=dev-user-1 拿到真实会话。
 *    itest 档不装配闸门（保持既有集成测试语义）。
 */
@Component
@Profile({"dev", "itest"}) // itest = 单测 H2 档（不连库生产环境，无真实凭证）
public class DevWechatSessionProvider implements WechatSessionProvider {

    /** dev 档才有该 bean（itest 为 null → 不设闸门）。 */
    private final ObjectProvider<DevLoginGuard> guard;

    public DevWechatSessionProvider(ObjectProvider<DevLoginGuard> guard) {
        this.guard = guard;
    }

    private void checkGuard(String scene) {
        DevLoginGuard g = guard == null ? null : guard.getIfAvailable();
        if (g != null) g.assertAllowed(scene);
    }

    @Override
    public WechatSessionInfo getSessionByCode(String code) {
        checkGuard("login");
        String openid = code != null && code.contains("dev-user-2") ? "dev-user-2" : "dev-user-1";
        String nickname = "dev-user-2".equals(openid) ? "开发用户乙" : "开发用户甲";
        return new WechatSessionInfo(openid, nickname, "dev-session-key");
    }

    @Override
    public String getPhoneNumberByCode(String phoneCode) {
        if (phoneCode == null || !phoneCode.startsWith("dev-phone-")) {
            return null;
        }
        checkGuard("phone");
        String digits = phoneCode.substring("dev-phone-".length());
        return digits.matches("^1\\d{10}$") ? digits : null;
    }
}
