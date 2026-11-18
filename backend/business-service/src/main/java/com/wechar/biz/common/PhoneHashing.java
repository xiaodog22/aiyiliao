package com.wechar.biz.common;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * 手机号哈希（审计 H2）。
 *
 * <p>历史实现直接 {@code SHA-256(phone)}：11 位手机号取值空间小且号段可枚举，拿到
 * phone_hash 后可用预计算表反查，再跨 users / family_members 关联同一自然人。
 * 生产改为 HMAC-SHA256(APP_PHONE_HMAC_KEY, phone)。</p>
 *
 * <p>迁移采用双读不双写：新绑定/新挑战写 HMAC；旧行仍是 SHA-256。
 * 查询时同时用 HMAC 与 legacy 摘要查找；比对成功后由调用方把旧行升级为 HMAC
 * （{@link com.wechar.biz.user.UserRepository#updatePhoneHash}）。
 * 联调档允许无密钥并回落旧 SHA-256，生产由 {@code ProductionSecurityCheck} 强制密钥，
 * 避免本地/测试环境全部无法启动。</p>
 */
@Component
public class PhoneHashing {

    private static final Logger log = LoggerFactory.getLogger(PhoneHashing.class);

    private final String secret;
    private final String previousSecret;

    public PhoneHashing(@Value("${app.auth.phone-hmac-key:}") String secret,
                        @Value("${app.auth.phone-hmac-key-previous:}") String previousSecret) {
        this.secret = secret == null ? "" : secret.trim();
        this.previousSecret = previousSecret == null ? "" : previousSecret.trim();
        if (this.secret.isEmpty()) {
            log.warn("APP_PHONE_HMAC_KEY 未配置：手机号哈希回落无盐 SHA-256（仅限 dev/itest；生产启动自检会拒绝）");
        }
    }

    /** 新写入使用的手机号摘要：生产 HMAC，联调档无密钥时回落历史 SHA-256。 */
    public String hash(String phone) {
        String normalized = normalize(phone);
        if (normalized == null) {
            return null;
        }
        return secret.isEmpty() ? legacyHash(normalized) : Digests.hmacSha256Hex(secret, normalized);
    }

    /** 历史无盐 SHA-256，仅用于旧数据双读与迁移，不得用于新写入。 */
    public String legacyHash(String phone) {
        String normalized = normalize(phone);
        return normalized == null ? null : Digests.sha256Hex(normalized);
    }

    /** 上一把 HMAC 密钥的摘要：只读兼容旧密钥轮换窗口，不用于新写入。 */
    public String previousHash(String phone) {
        String normalized = normalize(phone);
        if (normalized == null || previousSecret.isEmpty()) {
            return null;
        }
        return Digests.hmacSha256Hex(previousSecret, normalized);
    }

    /**
     * 比对库里已有的 phone_hash 与明文手机号：同时接受新 HMAC、上一把 HMAC 与旧 SHA-256。
     * 返回 true 只代表匹配；调用方应通过 {@link #needsUpgrade(String, String)} 决定是否回写。
     */
    public boolean matches(String storedHash, String phone) {
        String normalized = normalize(phone);
        if (storedHash == null || normalized == null) {
            return false;
        }
        if (Digests.constantTimeEquals(storedHash, hash(normalized))
                || Digests.constantTimeEquals(storedHash, legacyHash(normalized))) {
            return true;
        }
        String previous = previousHash(normalized);
        return previous != null && Digests.constantTimeEquals(storedHash, previous);
    }

    /** 库里仍是旧 SHA-256（或新密钥轮换前摘要）时需要回写。 */
    public boolean needsUpgrade(String storedHash, String phone) {
        String current = hash(phone);
        return storedHash != null && current != null && !Digests.constantTimeEquals(storedHash, current);
    }

    /** 供登录查找使用的候选摘要（新 → 上一把 → 旧 SHA-256）；空手机号返回空列表。 */
    public java.util.List<String> candidateHashes(String phone) {
        String normalized = normalize(phone);
        if (normalized == null) {
            return java.util.List.of();
        }
        java.util.List<String> out = new java.util.ArrayList<>();
        addDistinct(out, hash(normalized));
        addDistinct(out, previousHash(normalized));
        addDistinct(out, legacyHash(normalized));
        return java.util.List.copyOf(out);
    }

    private static void addDistinct(java.util.List<String> out, String value) {
        if (value != null && !out.contains(value)) {
            out.add(value);
        }
    }

    private static String normalize(String phone) {
        if (phone == null) {
            return null;
        }
        String value = phone.trim();
        return value.isEmpty() ? null : value;
    }
}
