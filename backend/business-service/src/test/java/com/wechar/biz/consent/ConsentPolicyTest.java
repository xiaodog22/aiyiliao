package com.wechar.biz.consent;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wechar.biz.common.ApiException;
import org.junit.jupiter.api.Test;

/** 审计 M11 回归：登录只接受服务端当前政策版本，空白/旧版本一律 409。 */
class ConsentPolicyTest {

    @Test
    void 当前版本放行_旧版本或空白拒绝() {
        ConsentPolicy policy = new ConsentPolicy("v2026.11", "2026-11-18", "隐私政策");

        policy.requireCurrent("v2026.11");

        assertThatThrownBy(() -> policy.requireCurrent("v1.0"))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getCode())
                        .isEqualTo("CONSENT_VERSION_MISMATCH"));
        assertThatThrownBy(() -> policy.requireCurrent(" "))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getCode())
                        .isEqualTo("CONSENT_VERSION_MISMATCH"));
        assertThatThrownBy(() -> policy.requireCurrent(null))
                .isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getCode())
                        .isEqualTo("CONSENT_VERSION_MISMATCH"));
    }

    @Test
    void 公开元数据不返回政策全文() {
        ConsentPolicy policy = new ConsentPolicy("v1.0", "2026-11-18", "隐私政策");

        assertThat(policy.latest())
                .containsEntry("version", "v1.0")
                .containsEntry("effectiveAt", "2026-11-18")
                .containsKeys("title", "purposes");
    }
}
