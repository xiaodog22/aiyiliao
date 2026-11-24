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

    /**
     * 终端标识请求头（审计 F1-4 短期补偿，2026-11-23）。
     *
     * <p>当前只有共享令牌、无法区分具体操作人。审批行已有 reviewed_at 时间戳，但 reviewer
     * 恒为 "nurse-station"，事后无法定位是哪台终端通过/驳回了申请。前端在 localStorage
     * 生成并持久化一个随机终端号，随审批请求上报；服务端只接受 {@code [A-Za-z0-9._-]{1,32}}，
     * 拼进 reviewer 列（≤64 字符）作为短期追溯线索。</p>
     *
     * <p>⚠️ 该值由客户端自报，只能用于"同一终端行为聚合"，不能当作身份认证；
     * 彻底方案仍是独立护士账号 + RBAC（见 REPORT 的剩余项）。</p>
     */
    public static final String TERMINAL_HEADER = "X-Nurse-Terminal-Id";

    private static final java.util.regex.Pattern TERMINAL_PATTERN =
            java.util.regex.Pattern.compile("[A-Za-z0-9._-]{1,32}");

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

    /**
     * 审批人字段：{@code nurse-station@<terminal>}。终端号非法/缺失时回落 unidentified，
     * 不拒绝请求（不能因为追溯字段缺失而阻断临床审批），但保留"共享终端、无个体身份"的事实。
     */
    public String reviewerOf(String terminalId) {
        String raw = terminalId == null ? "" : terminalId.trim();
        String normalized = TERMINAL_PATTERN.matcher(raw).matches() ? raw : "unidentified";
        return "nurse-station@" + normalized;
    }

    private static boolean constantTimeEquals(String expected, String actual) {
        return MessageDigest.isEqual(expected.getBytes(StandardCharsets.UTF_8),
                actual.getBytes(StandardCharsets.UTF_8));
    }
}
