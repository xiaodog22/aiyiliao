package com.wechar.biz.auth;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.wechar.biz.common.ApiException;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.web.context.request.RequestContextHolder;
import org.springframework.web.context.request.ServletRequestAttributes;

/**
 * 联调登录闸门单元测试（不起 Spring 上下文）。
 *
 * <p>钉死三件事：</p>
 * <ol>
 *   <li>未显式开启 → 一律 403（默认就是关闭，误暴露也不放行）；</li>
 *   <li>开启但未配置密钥 → 403（配置缺失不得降级为"放行"）；</li>
 *   <li>密钥不匹配 / 缺头 → 403；完全匹配 → 放行。</li>
 * </ol>
 * 背景：dev 档 provider 只要 code 形态对就签发真会话，隧道暴露时等于无凭证登录。
 */
class DevLoginGuardTest {

    private static final String KEY = "unit-test-dev-login-key-not-real";

    @AfterEach
    void clearRequest() {
        RequestContextHolder.resetRequestAttributes();
    }

    private static void bindHeader(String value) {
        MockHttpServletRequest req = new MockHttpServletRequest("POST", "/api/v1/auth/wechat/login");
        if (value != null) req.addHeader(DevLoginGuard.HEADER, value);
        RequestContextHolder.setRequestAttributes(new ServletRequestAttributes(req));
    }

    @Test
    void 未开启时一律拒绝_不签发会话() {
        DevLoginGuard guard = new DevLoginGuard(false, KEY, "");
        bindHeader(KEY);
        ApiException e = assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
        assertEquals("DEV_LOGIN_FORBIDDEN", e.getCode());
        assertEquals(HttpStatus.FORBIDDEN, e.getStatus());
    }

    @Test
    void 开启但密钥为空_拒绝而不是放行() {
        DevLoginGuard guard = new DevLoginGuard(true, "  ", "");
        bindHeader("");
        ApiException e = assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
        assertEquals("DEV_LOGIN_FORBIDDEN", e.getCode());
    }

    @Test
    void 开启且配密钥_缺头或错头_拒绝() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY, "");

        bindHeader(null);
        assertThrows(ApiException.class, () -> guard.assertAllowed("login"));

        bindHeader("wrong-key");
        assertThrows(ApiException.class, () -> guard.assertAllowed("phone"));
    }

    @Test
    void 开启且配密钥_头匹配_放行() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY, "");
        bindHeader(KEY);
        assertDoesNotThrow(() -> guard.assertAllowed("login"));
    }

    @Test
    void 无请求上下文_按拒绝处理_不静默放行() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY, "");
        assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
    }

    @Test
    void 配置成已泄露的旧密钥_启动即失败() {
        // 审计 C1：轮换不等于撤销 —— 把旧值当新值继续用必须直接拒绝启动
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> new DevLoginGuard(true, "wb-devlogin-281819dbbf8ade34e27ac5fb04ce48a6",
                        DevLoginGuard.DEFAULT_REVOKED_KEYS));
        assertTrue(e.getMessage().contains("已泄露"));
    }

    @Test
    void 请求头命中已撤销的黑名单_拒绝() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY, DevLoginGuard.DEFAULT_REVOKED_KEYS);
        bindHeader("wb-devlogin-21cbddfc3b21990d6df374f6fa3f92cc");
        ApiException e = assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
        assertEquals("DEV_LOGIN_FORBIDDEN", e.getCode());
    }

    @Test
    void 本地已轮换旧钥同样在撤销名单内() {
        // 复审 P3：本地 ignored 的 e6a9… 已撤销；留在任何环境都不再具备登录能力
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> new DevLoginGuard(true, "wb-devlogin-e6a98a5b0c2712b344b077d87eb29035",
                        DevLoginGuard.DEFAULT_REVOKED_KEYS));
        assertTrue(e.getMessage().contains("已泄露"));
    }
}
