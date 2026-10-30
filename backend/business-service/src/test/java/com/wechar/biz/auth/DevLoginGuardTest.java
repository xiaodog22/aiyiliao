package com.wechar.biz.auth;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

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
        DevLoginGuard guard = new DevLoginGuard(false, KEY);
        bindHeader(KEY);
        ApiException e = assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
        assertEquals("DEV_LOGIN_FORBIDDEN", e.getCode());
        assertEquals(HttpStatus.FORBIDDEN, e.getStatus());
    }

    @Test
    void 开启但密钥为空_拒绝而不是放行() {
        DevLoginGuard guard = new DevLoginGuard(true, "  ");
        bindHeader("");
        ApiException e = assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
        assertEquals("DEV_LOGIN_FORBIDDEN", e.getCode());
    }

    @Test
    void 开启且配密钥_缺头或错头_拒绝() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY);

        bindHeader(null);
        assertThrows(ApiException.class, () -> guard.assertAllowed("login"));

        bindHeader("wrong-key");
        assertThrows(ApiException.class, () -> guard.assertAllowed("phone"));
    }

    @Test
    void 开启且配密钥_头匹配_放行() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY);
        bindHeader(KEY);
        assertDoesNotThrow(() -> guard.assertAllowed("login"));
    }

    @Test
    void 无请求上下文_按拒绝处理_不静默放行() {
        DevLoginGuard guard = new DevLoginGuard(true, KEY);
        assertThrows(ApiException.class, () -> guard.assertAllowed("login"));
    }
}
