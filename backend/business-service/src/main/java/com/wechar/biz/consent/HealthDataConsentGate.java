package com.wechar.biz.consent;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.GlobalExceptionHandler;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * 健康数据单独同意门禁（审计 F4-1，2026-11-23）。
 *
 * <p>《个人信息保护法》第 29 条要求处理敏感个人信息取得单独同意。此前业务侧只在
 * 「已撤回」时拦截（{@code PatientService.interpret}），「从未授权」直接放行，且前端没有任何
 * 授予入口 —— 结果是患者的症状文本在只有登录一般同意的情况下就进入 AI 处理链路。</p>
 *
 * <p>本门禁把口径统一为三态，并在所有会处理健康文本的业务入口前置调用：</p>
 * <ul>
 *   <li>从未授权 → 422 {@code CONSENT_REQUIRED}（前端弹单独授权页，授予后重试）；</li>
 *   <li>已撤回 → 422 {@code CONSENT_WITHDRAWN}（停止处理，重新授权后恢复）；</li>
 *   <li>授权版本 ≠ 当前发布的隐私政策版本 → 409 {@code CONSENT_VERSION_MISMATCH}
 *       （政策或授权文本已更新，必须重新阅读并确认）。</li>
 * </ul>
 *
 * <p>配置 {@code app.consent.require-health-data} 默认 true。单测档（itest）显式关闭
 * 「必须先授予 / 版本必须匹配」的前置要求，避免 900+ 既有用例全部需要预置同意数据；
 * 但「已撤回」是硬拦截，不受该开关影响。新增的 {@code HealthDataConsentGateTest}
 * 单独打开本开关验证拦截与放行，生产档不受影响。</p>
 */
@Component
public class HealthDataConsentGate {

    public static final String HEALTH_DATA = "HEALTH_DATA_PROCESSING";
    public static final String VOICE_RECORDING = "VOICE_RECORDING";

    private final ConsentRepository consentRepository;
    private final ConsentPolicy consentPolicy;
    private final boolean required;

    public HealthDataConsentGate(ConsentRepository consentRepository, ConsentPolicy consentPolicy,
                                 @Value("${app.consent.require-health-data:true}") boolean required) {
        this.consentRepository = consentRepository;
        this.consentPolicy = consentPolicy;
        this.required = required;
    }

    /** 健康数据处理（症状文本 / 健康档案 / 报告摘要 / 问诊上下文）。 */
    public void requireHealth(String userId, String action) {
        require(userId, HEALTH_DATA, action);
    }

    /** 录音与语音转写（录音本身即敏感个人信息采集）。 */
    public void requireVoice(String userId, String action) {
        require(userId, VOICE_RECORDING, action);
    }

    /** 指定处理目的的单独同意校验。 */
    public void require(String userId, String purpose, String action) {
        Map<String, Object> latest = consentRepository.findLatest(userId, purpose).orElse(null);
        // 撤回是「停止处理」的硬信号：即使单测档关闭了「必须先授予」的开关，撤回也必须立即生效。
        // 既有用例 MeExtendedProfileContractTest.interpret_撤回同意_422 依赖这一语义。
        if (latest != null && "WITHDRAWN".equals(String.valueOf(latest.get("status")))) {
            throw new ApiException("CONSENT_WITHDRAWN", HttpStatus.UNPROCESSABLE_ENTITY,
                    consentLabel(purpose) + "已撤回，无法继续" + action + "（可前往设置重新授权后重试）");
        }
        // 关闭开关只跳过「从未授权 / 版本过期」的前置要求（仅单测档，避免 900+ 旧用例全部造数据）。
        if (!required) {
            return;
        }
        if (latest == null) {
            throw new ApiException("CONSENT_REQUIRED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "请先阅读并同意" + consentLabel(purpose) + "，再使用" + action, false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "consent", "处理敏感个人信息需要单独同意", "CONSENT_REQUIRED")));
        }
        String status = String.valueOf(latest.get("status"));
        if (!"GRANTED".equals(status)) {
            throw new ApiException("CONSENT_REQUIRED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "请先阅读并同意" + consentLabel(purpose) + "，再使用" + action);
        }
        String grantedVersion = latest.get("policyVersion") == null
                ? "" : String.valueOf(latest.get("policyVersion"));
        if (!consentPolicy.currentVersion().equals(grantedVersion)) {
            throw new ApiException("CONSENT_VERSION_MISMATCH", HttpStatus.CONFLICT,
                    consentLabel(purpose) + "版本已更新，请重新阅读并同意后再使用" + action, false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "policyVersion", "当前有效版本 " + consentPolicy.currentVersion(),
                            "CONSENT_VERSION_MISMATCH")));
        }
    }

    private static String consentLabel(String purpose) {
        return VOICE_RECORDING.equals(purpose) ? "《语音录制授权说明》" : "《健康数据处理授权说明》";
    }
}
