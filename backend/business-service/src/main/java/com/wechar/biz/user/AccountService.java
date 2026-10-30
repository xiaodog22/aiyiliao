package com.wechar.biz.user;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.auth.SmsChallengeService;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.AuthSessionStore;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.consent.ConsentRepository;
import com.wechar.biz.consultation.ConsultationRepository;
import com.wechar.biz.user.dto.AccountDeletionVerifyRequest;
import com.wechar.biz.user.dto.AuthRevokeRequest;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 账号生命周期服务（N10 注销 / N11 撤回授权，2026-10-19；契约 deleteAccount / revokeAuthorization）。
 *
 * N10 红线（逐条落实）：
 *  - **软删不物理删库**：users.status=DELETION_PENDING + deletion_requested_at/effective_at
 *    （30 天冷静期，冷静期到期清除由后续任务按 effective_at 执行，本批不实现清除）；
 *  - 当前会话链立即撤销（AuthSessionStore.revokeByAccessToken）；冷静期内不可再登录
 *    （AuthService.issueSession 收口 403）；
 *  - 409 = 未完成预约（PENDING/CONFIRMED/CHECKED_IN）或 24h 内有消息的 ACTIVE 问诊
 *    （问诊无关闭端点，时间窗口口径登记于契约）；
 *  - 422 = 二次校验失败（scene=ACCOUNT_DELETION 短信验证码缺失/错/过期/手机号不匹配）。
 *  幂等：Idempotency-Key 必填由控制器校验；注销为终态操作且成功即撤销会话
 *  （重放必然 401），故不落键值存储——契约未承诺同键重放语义。
 *
 * N11 红线：撤回后对应处理目的**停止处理**（consents 记 WITHDRAWN，
 * 已建门禁的处理路径即时生效，如 PatientService.interpret）；
 * **已合法收集的数据不主动删除**；同意记录只追加不覆盖。
 */
@Service
public class AccountService {

    /** 冷静期天数（契约登记 30 天，红线：软删）。 */
    static final int COOLDOWN_DAYS = 30;
    /** 进行中问诊的时间窗口（契约登记 24 小时）。 */
    static final int ACTIVE_CONSULT_WINDOW_HOURS = 24;

    /** N11 scope → 同意处理目的（契约 revokeAuthorization 描述逐字登记）。 */
    private static final Map<String, String> REVOKE_SCOPE_PURPOSE = Map.of(
            "PROFILE", "PRIVACY_POLICY",
            "HEALTH_RECORDS", "HEALTH_DATA_PROCESSING",
            "FAMILY", "FAMILY_PROXY");

    private static final String VERIFY_FAILED_MESSAGE = "二次校验失败，请使用绑定手机号重新获取验证码";

    private final UserRepository userRepository;
    private final AppointmentRepository appointmentRepository;
    private final ConsultationRepository consultationRepository;
    private final ConsentRepository consentRepository;
    private final SmsChallengeService smsChallengeService;
    private final AuthSessionStore authSessionStore;
    private final Clock clock;

    public AccountService(UserRepository userRepository, AppointmentRepository appointmentRepository,
                          ConsultationRepository consultationRepository, ConsentRepository consentRepository,
                          SmsChallengeService smsChallengeService, AuthSessionStore authSessionStore,
                          Clock clock) {
        this.userRepository = userRepository;
        this.appointmentRepository = appointmentRepository;
        this.consultationRepository = consultationRepository;
        this.consentRepository = consentRepository;
        this.smsChallengeService = smsChallengeService;
        this.authSessionStore = authSessionStore;
        this.clock = clock;
    }

    /** 契约 deleteAccount：409（未完成业务）→ 422（二次校验）→ 软删 + 撤销会话 → {ok:true}。 */
    @Transactional
    public Map<String, Object> deleteAccount(String userId, AccountDeletionVerifyRequest request,
                                             String accessToken) {
        Instant now = clock.instant();

        // 409：未完成预约/问诊（前端引导先处理；口径见契约 description）
        int unfinished = appointmentRepository.countUnfinishedForUser(userId);
        int activeConsults = consultationRepository.countRecentActiveForUser(userId,
                now.minus(ACTIVE_CONSULT_WINDOW_HOURS, ChronoUnit.HOURS));
        if (unfinished > 0 || activeConsults > 0) {
            throw new ApiException("ACCOUNT_HAS_UNFINISHED_BUSINESS", HttpStatus.CONFLICT,
                    "存在未完成的预约或进行中的问诊，请先取消预约或结束问诊后再注销", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail("unfinished",
                            "未完成预约 " + unfinished + " 条、进行中问诊 " + activeConsults + " 条",
                            "ACCOUNT_HAS_UNFINISHED_BUSINESS")));
        }

        // 422：二次校验（scene 隔离 + 手机号必须为账号绑定手机号）
        var user = userRepository.findById(userId)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在"));
        if (user.phoneHash() == null) {
            throw new ApiException("VERIFY_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "该账号未绑定手机号，无法完成二次校验（请先绑定手机号）");
        }
        SmsChallengeService.VerifiedChallenge challenge;
        try {
            challenge = smsChallengeService.verify(request.challengeId().trim(), request.code().trim(),
                    "ACCOUNT_DELETION");
        } catch (ApiException e) {
            // verify 内部 attempts 累计保留（防穷举）；对外统一契约 422 二次校验失败
            throw new ApiException("VERIFY_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, VERIFY_FAILED_MESSAGE);
        }
        if (!user.phoneHash().equals(challenge.phoneHash())) {
            throw new ApiException("VERIFY_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, VERIFY_FAILED_MESSAGE);
        }
        smsChallengeService.consume(challenge.challengeId());

        // 软删（30 天冷静期；重复调用不重置起点——WHERE status='ACTIVE'）+ 撤销当前会话链
        int updated = userRepository.markDeletionRequested(userId, now, now.plus(COOLDOWN_DAYS, ChronoUnit.DAYS));
        if (updated == 0) {
            throw new ApiException("VERIFY_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "账号已处于注销冷静期，无需重复操作");
        }
        if (accessToken != null && !accessToken.isBlank()) {
            authSessionStore.revokeByAccessToken(accessToken);
        }
        return Map.of("ok", true);
    }

    /**
     * 契约 revokeAuthorization：scope → 处理目的，只追加 WITHDRAWN；
     * 从未授意 → 幂等终态（不追加行，同样 revoked:true）；同键异载荷 → 409（契约已声明）。
     */
    @Transactional
    public Map<String, Object> revoke(String userId, String idempotencyKey, AuthRevokeRequest request) {
        String scope = request.scope(); // @Pattern 已保证取值合法（bean validation → 422）
        String purpose = REVOKE_SCOPE_PURPOSE.get(scope);
        String digest = Digests.sha256Hex(scope);

        var recorded = consentRepository.findDigestByIdempotencyKey(userId, idempotencyKey);
        if (recorded.isPresent()) {
            if (!digest.equals(recorded.get())) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
            }
            return Map.of("revoked", true); // 同键同载荷 → 重放终态
        }

        Instant now = clock.instant();
        var latest = consentRepository.findLatest(userId, purpose);
        if (latest.isPresent() && "GRANTED".equals(latest.get().get("status"))) {
            Map<String, Object> granted = latest.get();
            // 只追加不覆盖：沿用原 policyVersion/channel，追加 WITHDRAWN（撤回记录不消失）
            consentRepository.append("cs-" + UUID.randomUUID(), userId, purpose,
                    String.valueOf(granted.get("policyVersion")), "WITHDRAWN",
                    granted.get("channel") == null ? null : String.valueOf(granted.get("channel")),
                    null, null, now, "用户撤回授权（scope=" + scope + "）", idempotencyKey, digest, now);
        }
        // 从未授意 / 已是 WITHDRAWN：无需追加，撤回语义同样成立（幂等终态）
        return Map.of("revoked", true);
    }
}
