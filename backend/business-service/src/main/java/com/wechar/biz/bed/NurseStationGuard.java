package com.wechar.biz.bed;

import com.wechar.biz.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 护士站终端令牌校验（2026-11-19）。
 *
 * <p>系统当前只有患者/医生两类账号，尚无独立护士账号体系。为了让「医生申请 → 护士站审批」
 * 先跑通，这里用病区护士站终端共享令牌做最小闭环：
 *  · 令牌只允许调用床位申请审批端点，不携带患者身份，也不能访问病历/处方等临床数据；
 *  · 令牌由运行环境注入 {@code NURSE_STATION_TOKEN}，不写进任何配置文件；
 *  · 未配置时端点返回 503（fail-closed），不会退化成"无令牌即可审批"。</p>
 *
 * <p>生产上线前应替换为独立护士账号 + RBAC（见 docs/clinic-his-integration/02）。</p>
 */
@Component
public class NurseStationGuard {

    /** 终端请求头：与 Bearer 分开，避免和医生/患者会话混用。 */
    public static final String HEADER = "X-Nurse-Station-Token";

    private final String configuredToken;

    public NurseStationGuard(@Value("${app.nurse.station-token:}") String configuredToken) {
        this.configuredToken = configuredToken == null ? "" : configuredToken.trim();
    }

    /**
     * 校验终端令牌。缺失/错误 → 403；服务端未配置 → 503。
     * 使用常量时间比较，避免按字符逐位计时猜测令牌。
     */
    public void require(String headerToken) {
        if (configuredToken.isEmpty()) {
            throw new ApiException("NURSE_STATION_DISABLED", HttpStatus.SERVICE_UNAVAILABLE,
                    "护士站审批未启用：请由信息科配置 NURSE_STATION_TOKEN 后重启服务");
        }
        String presented = headerToken == null ? "" : headerToken.trim();
        if (!constantTimeEquals(configuredToken, presented)) {
            throw new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN, "护士站终端令牌无效");
        }
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8));
    }
}
