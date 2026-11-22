package com.wechar.biz.appointment.his;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.mock.env.MockEnvironment;

/**
 * L6（2026-11-22 敌意审查）：HIS mode 必须 fail-closed。
 *
 * <p>原缺陷：{@code app.his.mode} 默认 "mock" + MockHisClient {@code matchIfMissing=true}，
 * 只打开 {@code app.his.enabled=true} 会静默使用模拟适配器——运维以为接了医院系统，
 * 实际预约只落在内存里，且页面可能标识「已受理」。现在缺 mode 立即拒绝启动。
 */
class HisModeFailClosedTest {

    @Test
    void enabled为true但mode缺失_拒绝启动() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> new HisGateway(new MockHisClient(), true, ""));
        assertTrue(e.getMessage().contains("app.his.mode"), "错误信息必须指明缺失配置项");
    }

    @Test
    void enabled为true但mode为空白_拒绝启动() {
        assertThrows(IllegalStateException.class, () -> new HisGateway(new MockHisClient(), true, "   "));
    }

    @Test
    void enabled为true但mode非法_拒绝启动() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> new HisGateway(new MockHisClient(), true, "sandbox"));
        assertTrue(e.getMessage().contains("不支持"));
    }

    @Test
    void enabled为true但无对应实现_拒绝启动() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> new HisGateway((HisClient) null, true, "http"));
        assertTrue(e.getMessage().contains("没有对应 HisClient"));
    }

    @Test
    void enabled为false_mode可缺省且不触达外部() {
        HisGateway gateway = new HisGateway((HisClient) null, false, "");
        assertFalse(gateway.enabled());
        assertEquals("disabled", gateway.mode());
        // 开关关闭时 book 直接走 LOCAL_DEMO，不要求 command 非空（也不触碰 client）
        assertEquals("LOCAL_DEMO", gateway.book(null).source());
    }

    @Test
    void enabled为true且mode显式mock_可正常装配() {
        HisGateway gateway = new HisGateway(new MockHisClient(), true, "mock");
        assertTrue(gateway.enabled());
        assertEquals("mock", gateway.mode());
    }

    @Test
    void mode大写MOCK按大小写不敏感处理() {
        HisGateway gateway = new HisGateway(new MockHisClient(), true, "MOCK");
        assertTrue(gateway.enabled());
        assertEquals("mock", gateway.mode(), "mode 应归一化为小写，MOCK 不得因大小写漏判");
    }

    @Test
    void 生产档位配mock_启动自检拒绝() {
        IllegalStateException e = assertThrows(IllegalStateException.class,
                () -> new ProductionHisModeCheck("MOCK", env("prod")).verify());
        assertTrue(e.getMessage().contains("禁止"));
        assertThrows(IllegalStateException.class,
                () -> new ProductionHisModeCheck("mock", env("prod")).verify());
    }

    @Test
    void 生产档位配http_启动自检放行() {
        new ProductionHisModeCheck("http", env("prod")).verify();
    }

    @Test
    void 生产profile激活时_mock配置导致上下文启动失败() {
        new ApplicationContextRunner()
                .withInitializer(ctx -> ctx.getEnvironment().setActiveProfiles("prod"))
                .withUserConfiguration(ProductionHisModeCheck.class)
                .withPropertyValues("app.his.mode=mock")
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @Test
    void 自定义profile配mock_同样拒绝启动() {
        // staging / production / 拼写错误的 profile 都不能成为 mock 的后门
        for (String profile : new String[]{"staging", "production", "uat"}) {
            IllegalStateException e = assertThrows(IllegalStateException.class,
                    () -> new ProductionHisModeCheck("mock", env(profile)).verify(),
                    profile + " 档位不得放行 mock");
            assertTrue(e.getMessage().contains("profiles="), "错误信息需带当前 profile");
        }
    }

    @Test
    void 无profile配mock_按生产处理拒绝启动() {
        new ApplicationContextRunner()
                .withUserConfiguration(ProductionHisModeCheck.class)
                .withPropertyValues("app.his.mode=mock")
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @Test
    void 显式dev档位配mock_放行() {
        for (String profile : new String[]{"dev", "itest", "test", "prodtest"}) {
            new ProductionHisModeCheck("mock", env(profile)).verify();
        }
    }

    private static MockEnvironment env(String... profiles) {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles(profiles);
        return environment;
    }
}
