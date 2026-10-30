package com.wechar.biz.user;

import java.time.Instant;
import java.sql.Timestamp;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * users 表数据访问（V1 已有表，M1 直接复用，不重复建表）。
 * phone_cipher 为 AES-GCM 密文的 Base64 字节（VARBINARY 列），响应永不回显原文。
 */
@Component
public class UserRepository {

    private final JdbcTemplate jdbc;

    public UserRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record UserRow(String id, String openid, byte[] phoneCipher, String phoneHash, boolean phoneBound,
                          String displayName, String avatarKey, String status, int version,
                          Instant createdAt, Instant updatedAt) {
    }

    private static UserRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new UserRow(
                rs.getString("id"),
                rs.getString("wechat_openid"),
                rs.getBytes("phone_cipher"),
                rs.getString("phone_hash"),
                rs.getBoolean("phone_bound"),
                rs.getString("display_name"),
                rs.getString("avatar_key"),
                rs.getString("status"),
                rs.getInt("version"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    private static final String COLS =
            "id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, avatar_key, status, version, created_at, updated_at";

    public Optional<UserRow> findById(String id) {
        return jdbc.query("SELECT " + COLS + " FROM users WHERE id = ?",
                UserRepository::map, id).stream().findFirst();
    }

    public Optional<UserRow> findByOpenid(String openid) {
        return jdbc.query("SELECT " + COLS + " FROM users WHERE wechat_openid = ?",
                UserRepository::map, openid).stream().findFirst();
    }

    /** 按手机号哈希定位账号（N8 账号登录：account 为手机号时的查询路径；不存明文故只能哈希比对）。 */
    public Optional<UserRow> findByPhoneHash(String phoneHash) {
        if (phoneHash == null || phoneHash.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query("SELECT " + COLS + " FROM users WHERE phone_hash = ?",
                UserRepository::map, phoneHash).stream().findFirst();
    }

    /** 登录自动创建：display_name 取微信昵称占位；未绑定时 phone_cipher 为 null。 */
    public void insert(String id, String openid, String displayName, Instant now) {
        jdbc.update("INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at) "
                        + "VALUES (?, ?, NULL, NULL, 0, ?, 'ACTIVE', 1, ?)",
                id, openid, displayName, Timestamp.from(now));
    }

    /** 手机绑定：密文 + SHA-256 哈希落库，phone_bound=1。 */
    public void bindPhone(String id, byte[] cipher, String phoneHash, Instant now) {
        jdbc.update("UPDATE users SET phone_cipher = ?, phone_hash = ?, phone_bound = 1, version = version + 1, updated_at = ? WHERE id = ?",
                cipher, phoneHash, Timestamp.from(now), id);
    }

    /** 个人信息设置：改名（PATCH /me/account）。 */
    public void updateDisplayName(String id, String displayName, Instant now) {
        jdbc.update("UPDATE users SET display_name = ?, version = version + 1, updated_at = ? WHERE id = ?",
                displayName, Timestamp.from(now), id);
    }

    /** 个人信息设置：换头像（avatar_key 存对外相对路径 /api/v1/avatars/<name> 或完整 URL）。 */
    public void updateAvatarKey(String id, String avatarKey, Instant now) {
        jdbc.update("UPDATE users SET avatar_key = ?, version = version + 1, updated_at = ? WHERE id = ?",
                avatarKey, Timestamp.from(now), id);
    }

    /**
     * N10 账号注销（软删红线）：status=DELETION_PENDING + 30 天冷静期时间戳，**不物理删库**；
     * 仅从 ACTIVE 流转（重复注销不会重置冷静期起点）。
     */
    public int markDeletionRequested(String id, Instant now, Instant effectiveAt) {
        return jdbc.update("UPDATE users SET status = 'DELETION_PENDING', deletion_requested_at = ?, "
                        + "deletion_effective_at = ?, version = version + 1, updated_at = ? "
                        + "WHERE id = ? AND status = 'ACTIVE'",
                Timestamp.from(now), Timestamp.from(effectiveAt), Timestamp.from(now), id);
    }

    /** F7 合规审计：记录登录请求携带的隐私政策版本（只记版本号，不构成同意本身）。 */
    public void recordLoginConsentVersion(String id, String consentVersion, Instant now) {
        jdbc.update("UPDATE users SET login_consent_version = ?, updated_at = ? WHERE id = ?",
                consentVersion, Timestamp.from(now), id);
    }
}
