package com.wechar.biz.auth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import com.wechar.biz.common.ApiException;

/**
 * dev 档会话派生规则（2026-11-22 新增医生端联调入口）。
 *
 * <p>覆盖三条不变量：
 * <ol>
 *   <li>{@code dev-doctor-<doctorId>} → openid {@code dev-doc-<doctorId>}，与 V9017 预建账号一致；</li>
 *   <li>该入口不放宽手机号白名单：手输 code 仍按白名单拒绝；</li>
 *   <li>既有患者身份（identity-map / dev-user-1 / dev-user-2）语义零变化。</li>
 * </ol>
 */
class DevWechatSessionProviderTest {

    private static DevWechatSessionProvider provider(String identityMap) {
        return new DevWechatSessionProvider(null, "13800138001,13900139001", identityMap);
    }

    @Test
    void 医生登录码_派生到预建的dev医生账号() {
        WechatSessionInfo info = provider("").getSessionByCode("dev-doctor-doc-cardio-1");
        assertThat(info.openid()).isEqualTo("dev-doc-doc-cardio-1");
        assertThat(info.nickname()).isEqualTo("演示医生");
    }

    @Test
    void 医生登录码_带连字符的ID完整保留() {
        assertThat(provider("").getSessionByCode("dev-doctor-doc-gastro-1").openid())
                .isEqualTo("dev-doc-doc-gastro-1");
    }

    @Test
    void 医生登录码_不命中时仍走患者默认身份() {
        // 形态不合法（大写/下划线/空）→ 不按医生处理，回落 dev-user-1
        assertThat(provider("").getSessionByCode("dev-doctor-DOC-1").openid()).isEqualTo("dev-user-1");
        assertThat(provider("").getSessionByCode("dev-doctor-").openid()).isEqualTo("dev-user-1");
    }

    @Test
    void 手输白名单_未登记手机号仍拒绝() {
        assertThatThrownBy(() -> provider("").getSessionByCode("dev-user-1-manual-13700000000"))
                .isInstanceOf(ApiException.class)
                .hasMessageContaining("手机号");
    }

    @Test
    void 既有患者身份_不受影响() {
        assertThat(provider("").getSessionByCode("dev-user-2-manual-13900139001").openid())
                .isEqualTo("dev-user-2");
        assertThat(provider("13800138001=dev-v9010-patient-a").getSessionByCode("dev-user-1-manual-13800138001").openid())
                .isEqualTo("dev-v9010-patient-a");
    }
}
