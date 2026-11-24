package com.wechar.biz.bed;

import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.mock;

import com.wechar.biz.common.AuthSessionStore;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.AuthInterceptor;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

/**
 * 审计 F1-3 的精确回归：护士站四条端点必须命中 AuthInterceptor 的匿名白名单，
 * 且只对声明的方法放行（不能把整个 /api/v1/nurse/** 一并放开）。
 *
 * <p>用纯单元测试而不是 MockMvc：H2 测试库的 Flyway target=26.7，没有 V29 的
 * bed_applications 表；白名单本身与数据库 schema 无关，直接调用 preHandle 更聚焦。</p>
 */
class NurseStationWhitelistTest {

    private final AuthInterceptor interceptor = new AuthInterceptor(
            mock(AuthSessionStore.class), "strict", new MockEnvironment());

    private boolean allowed(String method, String path) {
        MockHttpServletRequest request = new MockHttpServletRequest(method, path);
        return interceptor.preHandle(request, new MockHttpServletResponse(), new Object());
    }

    @Test
    void 护士站四条端点均不触发401() {
        assertTrue(allowed("GET", "/api/v1/nurse/beds"));
        assertTrue(allowed("GET", "/api/v1/nurse/bed-applications"));
        assertTrue(allowed("POST", "/api/v1/nurse/bed-applications/app-1/approve"));
        assertTrue(allowed("POST", "/api/v1/nurse/bed-applications/app-1/reject"));
    }

    @Test
    void 方法不匹配或越界路径仍然401() {
        // GET 不能借用 POST 审批路径的豁免
        assertThrows(ApiException.class, () -> allowed("GET", "/api/v1/nurse/bed-applications/app-1/approve"));
        // 未声明的护士站子路径不因前缀被连带放行
        assertThrows(ApiException.class, () -> allowed("GET", "/api/v1/nurse/bed-applications/app-1/detail"));
        assertThrows(ApiException.class, () -> allowed("DELETE", "/api/v1/nurse/beds"));
    }
}
