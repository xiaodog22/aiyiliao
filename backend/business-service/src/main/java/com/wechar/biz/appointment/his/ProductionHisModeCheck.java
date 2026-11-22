package com.wechar.biz.appointment.his;

import jakarta.annotation.PostConstruct;
import java.util.Arrays;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

/**
 * L6 细化（2026-11-22/23 敌意审查）：生产及**自定义 profile** 禁止 HIS mock。
 *
 * <p>MockHisClient 已加 {@code @Profile("!prod")}，但仅靠 profile 名无法覆盖
 * {@code staging} / {@code production} / 自定义 profile：这些档位会装配 MockHisClient，
 * 演示受理可能静默进入真实医院场景。
 *
 * <p>本自检改为 fail-closed：只要 {@code app.his.mode=mock}，**除非**显式激活
 * dev/itest/test/prodtest 之一，否则拒绝启动。无 profile（默认 prod 语义）同样拒绝。
 */
@Component
public class ProductionHisModeCheck {

    /** 唯一允许 mock 的显式非生产档位；新增档位必须在此登记，否则按生产处理。 */
    private static final Set<String> NON_PROD_PROFILES =
            Set.of("dev", "itest", "test", "prodtest");

    private final String mode;
    private final Environment environment;

    public ProductionHisModeCheck(@Value("${app.his.mode:}") String mode, Environment environment) {
        this.mode = mode == null ? "" : mode.trim();
        this.environment = environment;
    }

    @PostConstruct
    public void verify() {
        if (!"mock".equalsIgnoreCase(mode)) {
            return;
        }
        boolean explicitNonProd = Arrays.stream(environment.getActiveProfiles())
                .anyMatch(NON_PROD_PROFILES::contains);
        if (!explicitNonProd) {
            String profiles = Arrays.toString(environment.getActiveProfiles());
            throw new IllegalStateException(
                    "非 dev/test profile 禁止 app.his.mode=mock（演示受理不得进入生产），"
                            + "当前 profiles=" + profiles + "，拒绝启动");
        }
    }
}
