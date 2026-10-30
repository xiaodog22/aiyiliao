package com.wechar.biz.consent;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.consent.dto.ConsentGrantRequest;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 同意服务（契约 listConsents / grantConsent / withdrawConsent）：
 *  - 只追加不覆盖：grant 追加 GRANTED 行，withdraw 追加 WITHDRAWN 行；列表取每 purpose 最新一行；
 *  - 撤回终态幂等：已 WITHDRAWN 再撤回 → 200 返回同一终态（不新增行、不改口径）；
 *  - 幂等键：同键同载荷 → 重放；同键异载荷 → 409（键不构成读取凭证）。
 *  - 撤回不删除账号（契约 §9.3 撤回与注销分离）：本接口不触碰任何其他数据。
 */
@Service
public class ConsentService {

    /** 契约 ConsentPurpose 全集（新增取值时客户端须有未知值兜底；服务端不臆造）。 */
    private static final Set<String> PURPOSES = Set.of("PRIVACY_POLICY", "HEALTH_DATA_PROCESSING",
            "VOICE_RECORDING", "IMAGE_UPLOAD", "AI_GENERATION", "THIRD_PARTY_TTS", "FAMILY_PROXY", "MARKETING");

    /** 契约 ConsentGrantRequest.channel 全集。 */
    private static final Set<String> CHANNELS = Set.of("MINIPROGRAM", "OFFLINE", "PHONE");

    private static final int REASON_MAX = 200;

    private final ConsentRepository consentRepository;
    private final Clock clock;

    public ConsentService(ConsentRepository consentRepository, Clock clock) {
        this.consentRepository = consentRepository;
        this.clock = clock;
    }

    /** 契约 listConsents：撤回记录同样返回（不原地覆盖、不从列表消失）。 */
    @Transactional(readOnly = true)
    public List<Map<String, Object>> list(String userId) {
        return consentRepository.listFor(userId);
    }

    /** 契约 grantConsent：记录处理目的维度的单独同意（携带用户实际看到的政策版本）。 */
    @Transactional
    public Map<String, Object> grant(String userId, String idempotencyKey, ConsentGrantRequest request) {
        if (!PURPOSES.contains(request.purpose())) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "purpose 取值不在 ConsentPurpose 枚举内");
        }
        if (!CHANNELS.contains(request.channel())) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "channel 取值不在 [MINIPROGRAM, OFFLINE, PHONE] 内");
        }
        String digest = Digests.sha256Hex(canonical(request));

        var recorded = consentRepository.findDigestByIdempotencyKey(userId, idempotencyKey);
        if (recorded.isPresent()) {
            if (!digest.equals(recorded.get())) {
                throw reuseConflict();
            }
            return latestOrThrow(userId, request.purpose());
        }

        Instant now = clock.instant();
        consentRepository.append("cs-" + UUID.randomUUID(), userId, request.purpose(), request.policyVersion(),
                "GRANTED", request.channel(), consentRepository.scopeJson(request.scope()),
                request.evidenceDigest(), null, null, idempotencyKey, digest, now);
        return latestOrThrow(userId, request.purpose());
    }

    /**
     * 契约 withdrawConsent：撤回立即生效、仅可追加、不可删除；重复撤回返回同一终态。
     * purpose 不在枚举内或从未授权 → 404（该路径契约只声明 401/404/409，不臆造 422）。
     * reason 仅用于运营分析，按契约 ≤200 校验后如实落库。
     */
    @Transactional
    public Map<String, Object> withdraw(String userId, String purpose, String idempotencyKey, String reason) {
        if (reason != null && reason.length() > REASON_MAX) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "reason 长度不得超过 200 字符");
        }
        if (!PURPOSES.contains(purpose)) {
            throw new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "该处理目的下不存在同意记录");
        }
        String digest = Digests.sha256Hex(purpose + "|" + (reason == null ? "" : reason));

        var recorded = consentRepository.findDigestByIdempotencyKey(userId, idempotencyKey);
        if (recorded.isPresent()) {
            if (!digest.equals(recorded.get())) {
                throw reuseConflict();
            }
            return latestOrThrow(userId, purpose);
        }

        Map<String, Object> latest = latestOrThrow(userId, purpose);
        if ("WITHDRAWN".equals(latest.get("status"))) {
            return latest; // 重复撤回 → 同一终态（幂等），不新增行
        }

        Instant now = clock.instant();
        consentRepository.append("cs-" + UUID.randomUUID(), userId, purpose,
                String.valueOf(latest.get("policyVersion")), "WITHDRAWN",
                latest.get("channel") == null ? null : String.valueOf(latest.get("channel")),
                null, null, now, reason, idempotencyKey, digest, now);
        return latestOrThrow(userId, purpose);
    }

    private Map<String, Object> latestOrThrow(String userId, String purpose) {
        return consentRepository.findLatest(userId, purpose)
                .orElseThrow(() -> new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "该处理目的下不存在同意记录"));
    }

    private static ApiException reuseConflict() {
        return new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                List.of(new GlobalExceptionHandler.ErrorDetail(
                        "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
    }

    /** 载荷摘要：字段顺序固定，null 归一为空串；scope 保序拼接（同键同体判定依据）。 */
    private static String canonical(ConsentGrantRequest r) {
        return String.join("|",
                nullToEmpty(r.purpose()),
                nullToEmpty(r.policyVersion()),
                r.scope() == null ? "" : String.join(",", r.scope()),
                nullToEmpty(r.channel()),
                nullToEmpty(r.evidenceDigest()));
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
