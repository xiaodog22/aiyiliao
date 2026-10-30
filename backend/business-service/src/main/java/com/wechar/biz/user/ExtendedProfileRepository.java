package com.wechar.biz.user;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * user_extended 表数据访问（V8 新增，1:1 于 users）。
 * 邮箱/住宅/户籍为一般个人信息（明文）；身份证号/医保号为高敏证件号，
 * 与 phone 同口径：AES-GCM 密文（VARBINARY）+ SHA-256 哈希列，响应永不回显原文。
 */
@Component
public class ExtendedProfileRepository {

    private final JdbcTemplate jdbc;

    public ExtendedProfileRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ExtendedRow(String id, String userId, String email, String residence,
                              String householdRegistration, String idCardName, byte[] idCardCipher,
                              String idCardHash, boolean idCardVerified,
                              String insuranceType, byte[] insuranceNoCipher, String insuranceNoHash,
                              boolean insuranceBound, int version, Instant createdAt, Instant updatedAt) {
    }

    private static ExtendedRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new ExtendedRow(
                rs.getString("id"),
                rs.getString("user_id"),
                rs.getString("email"),
                rs.getString("residence"),
                rs.getString("household_registration"),
                rs.getString("id_card_name"),
                rs.getBytes("id_card_cipher"),
                rs.getString("id_card_hash"),
                rs.getBoolean("id_card_verified"),
                rs.getString("insurance_type"),
                rs.getBytes("insurance_no_cipher"),
                rs.getString("insurance_no_hash"),
                rs.getBoolean("insurance_bound"),
                rs.getInt("version"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    private static final String COLS =
            "id, user_id, email, residence, household_registration, id_card_name, id_card_cipher, id_card_hash, "
                    + "id_card_verified, insurance_type, insurance_no_cipher, insurance_no_hash, insurance_bound, "
                    + "version, created_at, updated_at";

    public Optional<ExtendedRow> findByUserId(String userId) {
        return jdbc.query("SELECT " + COLS + " FROM user_extended WHERE user_id = ?",
                ExtendedProfileRepository::map, userId).stream().findFirst();
    }

    /** 首次访问补建默认行（与 user_preferences 同模式），保证 GET 恒有形状。 */
    public void insertIfAbsent(String userId, Instant now) {
        if (findByUserId(userId).isPresent()) {
            return;
        }
        jdbc.update("INSERT INTO user_extended (id, user_id, version, created_at) VALUES (?, ?, 1, ?)",
                UUID.randomUUID().toString(), userId, Timestamp.from(now));
    }

    /** 联系方式/住址更新：null 字段保留原值；version 乐观锁递增。 */
    public void updateContact(String userId, String email, String residence, String householdRegistration,
                              Instant now) {
        jdbc.update("UPDATE user_extended SET "
                        + "email = COALESCE(?, email), residence = COALESCE(?, residence), "
                        + "household_registration = COALESCE(?, household_registration), "
                        + "version = version + 1, updated_at = ? WHERE user_id = ?",
                email, residence, householdRegistration, Timestamp.from(now), userId);
    }

    /** 身份证实名绑定：密文 + 哈希落库，verified=1（校验码校验通过即受理）。 */
    public void bindIdCard(String userId, String name, byte[] cipher, String hash, Instant now) {
        jdbc.update("UPDATE user_extended SET id_card_name = ?, id_card_cipher = ?, id_card_hash = ?, "
                        + "id_card_verified = 1, version = version + 1, updated_at = ? WHERE user_id = ?",
                name, cipher, hash, Timestamp.from(now), userId);
    }

    /** 医保绑定：类型明文 + 号码密文，bound=1。 */
    public void bindInsurance(String userId, String type, byte[] cipher, String hash, Instant now) {
        jdbc.update("UPDATE user_extended SET insurance_type = ?, insurance_no_cipher = ?, insurance_no_hash = ?, "
                        + "insurance_bound = 1, version = version + 1, updated_at = ? WHERE user_id = ?",
                type, cipher, hash, Timestamp.from(now), userId);
    }
}
