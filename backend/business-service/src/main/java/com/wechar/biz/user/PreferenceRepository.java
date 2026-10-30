package com.wechar.biz.user;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * user_preferences 表数据访问（V2 新表）。PUT 语义：整体覆盖提供的字段；version 乐观锁可选。
 */
@Component
public class PreferenceRepository {

    private final JdbcTemplate jdbc;

    public PreferenceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record PrefRow(String userId, String locale, String themeMode, String fontScale,
                          BigDecimal ttsRate, boolean ttsAutoPlay, int version, Instant updatedAt) {
    }

    private static PrefRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp updated = rs.getTimestamp("updated_at");
        return new PrefRow(
                rs.getString("user_id"),
                rs.getString("locale"),
                rs.getString("theme_mode"),
                rs.getString("font_scale"),
                rs.getBigDecimal("tts_rate"),
                rs.getBoolean("tts_auto_play"),
                rs.getInt("version"),
                updated == null ? null : updated.toInstant());
    }

    public Optional<PrefRow> findByUserId(String userId) {
        return jdbc.query("SELECT user_id, locale, theme_mode, font_scale, tts_rate, tts_auto_play, version, updated_at "
                        + "FROM user_preferences WHERE user_id = ?",
                PreferenceRepository::map, userId).stream().findFirst();
    }

    /** 懒创建默认偏好行（登录与首次读取都可调用，ON DUPLICATE 不需要——调用方先查）。 */
    public void insertIfAbsent(String userId, Instant now) {
        jdbc.update("INSERT INTO user_preferences (user_id, version, created_at) VALUES (?, 1, ?) "
                        + "ON DUPLICATE KEY UPDATE user_id = user_id",
                userId, Timestamp.from(now));
    }

    public boolean update(String userId, int expectedVersion, String locale, String themeMode, String fontScale,
                          BigDecimal ttsRate, boolean ttsAutoPlay, Instant now) {
        int updated = jdbc.update("UPDATE user_preferences SET locale = ?, theme_mode = ?, font_scale = ?, "
                        + "tts_rate = ?, tts_auto_play = ?, version = version + 1, updated_at = ? "
                        + "WHERE user_id = ? AND version = ?",
                locale, themeMode, fontScale, ttsRate, ttsAutoPlay, Timestamp.from(now), userId, expectedVersion);
        return updated == 1;
    }
}
