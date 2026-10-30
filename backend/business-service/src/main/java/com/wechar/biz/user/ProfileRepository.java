package com.wechar.biz.user;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * user_profiles 表数据访问（V1 已有表）。乐观锁：version 列，更新不匹配返回空（调用方转 409）。
 */
@Component
public class ProfileRepository {

    private final JdbcTemplate jdbc;

    public ProfileRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ProfileRow(String id, String userId, LocalDate birthDate, String sex,
                             BigDecimal heightCm, BigDecimal weightKg,
                             String allergies, String chronicConditions,
                             int version, Instant createdAt, Instant updatedAt) {
    }

    private static ProfileRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Date birth = rs.getDate("birth_date");
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new ProfileRow(
                rs.getString("id"),
                rs.getString("user_id"),
                birth == null ? null : birth.toLocalDate(),
                rs.getString("sex"),
                rs.getBigDecimal("height_cm"),
                rs.getBigDecimal("weight_kg"),
                rs.getString("allergies"),
                rs.getString("chronic_conditions"),
                rs.getInt("version"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    private static final String COLS =
            "id, user_id, birth_date, sex, height_cm, weight_kg, allergies, chronic_conditions, version, created_at, updated_at";

    public Optional<ProfileRow> findByUserId(String userId) {
        return jdbc.query("SELECT " + COLS + " FROM user_profiles WHERE user_id = ?",
                ProfileRepository::map, userId).stream().findFirst();
    }

    /** 登录自动创建空档案（任务书 M1 规则 1）。 */
    public void insert(String id, String userId, Instant now) {
        jdbc.update("INSERT INTO user_profiles (id, user_id, version, created_at) VALUES (?, ?, 1, ?)",
                id, userId, Timestamp.from(now));
    }

    /** 乐观锁更新：version 不匹配 → 返回 false（调用方转 409 VERSION_CONFLICT）。 */
    public boolean update(String id, int expectedVersion, LocalDate birthDate, String sex,
                          BigDecimal heightCm, BigDecimal weightKg,
                          String allergies, String chronicConditions, Instant now) {
        int updated = jdbc.update("UPDATE user_profiles SET birth_date = ?, sex = ?, height_cm = ?, weight_kg = ?, "
                        + "allergies = ?, chronic_conditions = ?, version = version + 1, updated_at = ? "
                        + "WHERE id = ? AND version = ?",
                birthDate == null ? null : Date.valueOf(birthDate), sex, heightCm, weightKg,
                allergies, chronicConditions, Timestamp.from(now), id, expectedVersion);
        return updated == 1;
    }
}
