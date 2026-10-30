package com.wechar.biz.auth;

import com.wechar.biz.auth.dto.SmsChallengeData;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import java.security.SecureRandom;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 短信验证码挑战服务（N9，2026-10-19；契约 sendSmsChallenge + doctorLoginByAccount 校验半段）：
 *  - 6 位验证码：SecureRandom 生成，库存 SHA-256 哈希（不存明文、不入日志）；
 *  - TTL 默认 300s（app.sms.ttl-seconds），过期即废；
 *  - 一次性：登录成功 {@link #consume} 原子置 consumed_at，重复使用 → 401；
 *  - 同手机号冷却 60s（app.sms.cooldown-seconds）内不重复下发 → 429 RATE_LIMITED；
 *  - attempts ≤ 5（app.sms.max-attempts）：连续输错即作废，防在线穷举 6 位码；
 *  - 下发经 {@link SmsSender}（dev=落库+脱敏日志；prod 占位如实 503，不伪造发送）。
 * 所有校验失败统一 401 同一文案（不区分原因，不给账号存在性/状态泄漏 oracle）。
 */
@Service
public class SmsChallengeService {

    /** 全部 401 场景共用文案（错误码/过期/已用/次数超限/账号不匹配一律同句，避免差异 oracle）。 */
    public static final String CREDENTIAL_REJECTED = "验证码错误、已过期或与账号不匹配，请重新获取";

    private static final SecureRandom RANDOM = new SecureRandom();

    private final JdbcTemplate jdbc;
    private final SmsSender smsSender;
    private final Clock clock;
    private final int ttlSeconds;
    private final int cooldownSeconds;
    private final int maxAttempts;

    public SmsChallengeService(JdbcTemplate jdbc, SmsSender smsSender, Clock clock,
                               @Value("${app.sms.ttl-seconds:300}") int ttlSeconds,
                               @Value("${app.sms.cooldown-seconds:60}") int cooldownSeconds,
                               @Value("${app.sms.max-attempts:5}") int maxAttempts) {
        this.jdbc = jdbc;
        this.smsSender = smsSender;
        this.clock = clock;
        this.ttlSeconds = Math.max(1, ttlSeconds);
        this.cooldownSeconds = Math.max(0, cooldownSeconds);
        this.maxAttempts = Math.max(1, maxAttempts);
    }

    /** 校验通过的挑战（phoneHash 供登录侧比对"验证码手机号 == 账号绑定手机号"）。 */
    public record VerifiedChallenge(String challengeId, String phoneHash) {
    }

    private record ChallengeRow(String phoneHash, String codeHash, String scene, Instant expiresAt,
                                Instant consumedAt, int attempts) {
    }

    /**
     * 契约 sendSmsChallenge：下发验证码。
     * 冷却命中 → 429（同一手机号 cooldownSeconds 内不重复下发）；
     * 短信网关失败（prod 占位 503）时事务回滚，不残留无主 challenge（避免"已下发但用户收不到"假状态）。
     */
    @Transactional
    public SmsChallengeData send(String phone, String scene, String idempotencyKey) {
        // idempotencyKey 已由控制器 IdempotencyKeys.require 校验（契约 required）；键本身不构成凭证
        String phoneHash = Digests.sha256Hex(phone);
        Instant now = clock.instant();

        if (cooldownSeconds > 0) {
            Integer recent = jdbc.queryForObject(
                    "SELECT COUNT(*) FROM sms_challenges WHERE phone_hash = ? AND created_at >= ?",
                    Integer.class, phoneHash, Timestamp.from(now.minusSeconds(cooldownSeconds)));
            if (recent != null && recent > 0) {
                throw new ApiException("RATE_LIMITED", HttpStatus.TOO_MANY_REQUESTS,
                        "短信发送过于频繁，请 " + cooldownSeconds + " 秒后重试", true, null);
            }
        }

        String code = sixDigitCode();
        String challengeId = "sms-" + UUID.randomUUID();
        jdbc.update("INSERT INTO sms_challenges "
                        + "(id, phone_hash, scene, code_hash, challenge_id, expires_at, consumed_at, attempts, created_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?)",
                "sm-" + UUID.randomUUID(), phoneHash, scene, Digests.sha256Hex(code), challengeId,
                Timestamp.from(now.plusSeconds(ttlSeconds)), Timestamp.from(now));
        smsSender.send(phone, code, scene);
        return new SmsChallengeData(challengeId, ttlSeconds);
    }

    /**
     * 校验 challengeId + 验证码（N8 登录 / N10 注销二次校验共用）：
     * 未知/过期/已用/次数超限/码错/场景不符 → 401 统一文案；码错时 attempts+1（超限即废）。
     * scene 隔离：N8 传 DOCTOR_LOGIN、N10 传 ACCOUNT_DELETION，跨场景复用按无效处理。
     */
    @Transactional
    public VerifiedChallenge verify(String challengeId, String credential, String scene) {
        List<ChallengeRow> rows = jdbc.query(
                "SELECT phone_hash, code_hash, scene, expires_at, consumed_at, attempts "
                        + "FROM sms_challenges WHERE challenge_id = ?",
                (rs, i) -> new ChallengeRow(rs.getString("phone_hash"), rs.getString("code_hash"),
                        rs.getString("scene"),
                        rs.getTimestamp("expires_at").toInstant(),
                        rs.getTimestamp("consumed_at") == null ? null : rs.getTimestamp("consumed_at").toInstant(),
                        rs.getInt("attempts")), challengeId);
        ChallengeRow row = rows.isEmpty() ? null : rows.get(0);
        Instant now = clock.instant();
        if (row == null || row.consumedAt() != null || !row.expiresAt().isAfter(now)
                || row.attempts() >= maxAttempts || !scene.equals(row.scene())) {
            throw rejected();
        }
        if (!row.codeHash().equals(Digests.sha256Hex(credential))) {
            jdbc.update("UPDATE sms_challenges SET attempts = attempts + 1 WHERE challenge_id = ?", challengeId);
            throw rejected();
        }
        return new VerifiedChallenge(challengeId, row.phoneHash());
    }

    /** 一次性消费：登录成功时原子置 consumed_at；已被使用 → 401（challengeId 一次性红线）。 */
    @Transactional
    public void consume(String challengeId) {
        int updated = jdbc.update(
                "UPDATE sms_challenges SET consumed_at = ? WHERE challenge_id = ? AND consumed_at IS NULL",
                Timestamp.from(clock.instant()), challengeId);
        if (updated == 0) {
            throw rejected();
        }
    }

    private static ApiException rejected() {
        return new ApiException("INVALID_CREDENTIAL", HttpStatus.UNAUTHORIZED, CREDENTIAL_REJECTED);
    }

    private static String sixDigitCode() {
        return String.format(java.util.Locale.ROOT, "%06d", RANDOM.nextInt(1_000_000));
    }
}
