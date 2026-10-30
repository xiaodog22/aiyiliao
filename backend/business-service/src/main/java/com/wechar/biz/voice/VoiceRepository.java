package com.wechar.biz.voice;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * voice 域数据访问（M2.3）：custom_voices / voice_preferences / tts_cache / asr_inputs。
 * 红线：asr_inputs 只留大小/摘要/过期时间做审计，不存音频字节、不存绝对路径。
 */
@Component
public class VoiceRepository {

    private final JdbcTemplate jdbc;

    public VoiceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    // ---------------------------------------------------------------- custom_voices

    public record CustomVoiceRow(String id, String userId, String displayName, String locale,
                                 String gender, Instant createdAt) {
    }

    private static final String VOICE_COLS = "id, user_id, display_name, locale, gender, created_at";

    private static CustomVoiceRow mapVoice(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        return new CustomVoiceRow(rs.getString("id"), rs.getString("user_id"), rs.getString("display_name"),
                rs.getString("locale"), rs.getString("gender"),
                created == null ? null : created.toInstant());
    }

    public List<CustomVoiceRow> findCustomVoices(String userId) {
        return jdbc.query("SELECT " + VOICE_COLS + " FROM custom_voices WHERE user_id = ? ORDER BY created_at DESC",
                VoiceRepository::mapVoice, userId);
    }

    public boolean customVoiceExists(String userId, String voiceId) {
        Integer count = jdbc.queryForObject(
                "SELECT COUNT(*) FROM custom_voices WHERE user_id = ? AND id = ?",
                Integer.class, userId, voiceId);
        return count != null && count > 0;
    }

    /** 幂等删除（DELETE /voices/{id} 防探测：不存在也返回成功，此处只删当前用户的）。 */
    public int deleteCustomVoice(String userId, String voiceId) {
        return jdbc.update("DELETE FROM custom_voices WHERE user_id = ? AND id = ?", userId, voiceId);
    }

    // ---------------------------------------------------------------- voice_preferences

    public record VoicePreferenceRow(String userId, String voiceId, BigDecimal rate, Boolean autoPlay,
                                     int version, Instant createdAt, Instant updatedAt) {
    }

    private static final String PREF_COLS = "user_id, voice_id, rate, auto_play, version, created_at, updated_at";

    private static VoicePreferenceRow mapPreference(java.sql.ResultSet rs, int rowNum)
            throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        // auto_play 为 TINYINT(1)：MySQL/H2 的 getObject 返回类型不一致（Boolean/Integer），
        // 硬转 Boolean 会在 H2 测试环境抛 ClassCastException（500），统一"非零即真"归一化
        Object autoPlayRaw = rs.getObject("auto_play");
        Boolean autoPlay = autoPlayRaw == null ? null
                : autoPlayRaw instanceof Boolean bool ? bool : ((Number) autoPlayRaw).intValue() != 0;
        return new VoicePreferenceRow(rs.getString("user_id"), rs.getString("voice_id"),
                rs.getBigDecimal("rate"), autoPlay, rs.getInt("version"),
                created == null ? null : created.toInstant(), updated == null ? null : updated.toInstant());
    }

    public Optional<VoicePreferenceRow> findPreference(String userId) {
        return jdbc.query("SELECT " + PREF_COLS + " FROM voice_preferences WHERE user_id = ?",
                VoiceRepository::mapPreference, userId).stream().findFirst();
    }

    /** upsert 偏好（同用户单行；version 自增用于乐观并发提示）。 */
    public void savePreference(String userId, String voiceId, BigDecimal rate, Boolean autoPlay, Instant now) {
        int updated = jdbc.update("UPDATE voice_preferences SET voice_id = ?, rate = ?, auto_play = ?, "
                        + "version = version + 1, updated_at = ? WHERE user_id = ?",
                voiceId, rate, autoPlay, Timestamp.from(now), userId);
        if (updated == 0) {
            jdbc.update("INSERT INTO voice_preferences (user_id, voice_id, rate, auto_play, version, "
                            + "created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
                    userId, voiceId, rate, autoPlay, Timestamp.from(now), Timestamp.from(now));
        }
    }

    // ---------------------------------------------------------------- tts_cache

    public record TtsCacheRow(String cacheKey, String audioUrl, String mime, Integer durationMs,
                              String engine, String voiceId, Instant createdAt, Instant expiresAt) {
    }

    /** 缓存命中（未过期）；过期行由调用方删除后重新合成。 */
    public Optional<TtsCacheRow> findTtsCache(String cacheKey, Instant now) {
        return jdbc.query("SELECT cache_key, audio_url, mime, duration_ms, engine, voice_id, created_at, expires_at "
                        + "FROM tts_cache WHERE cache_key = ? AND expires_at > ?",
                (rs, rowNum) -> new TtsCacheRow(rs.getString("cache_key"), rs.getString("audio_url"),
                        rs.getString("mime"), (Integer) rs.getObject("duration_ms"),
                        rs.getString("engine"), rs.getString("voice_id"),
                        rs.getTimestamp("created_at").toInstant(), rs.getTimestamp("expires_at").toInstant()),
                cacheKey, Timestamp.from(now)).stream().findFirst();
    }

    public void saveTtsCache(String cacheKey, String audioUrl, String mime, Integer durationMs,
                             String engine, String voiceId, Instant now, Instant expiresAt) {
        jdbc.update("INSERT INTO tts_cache (cache_key, audio_url, mime, duration_ms, engine, voice_id, "
                        + "created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?) "
                        + "ON DUPLICATE KEY UPDATE audio_url = VALUES(audio_url), mime = VALUES(mime), "
                        + "duration_ms = VALUES(duration_ms), engine = VALUES(engine), "
                        + "created_at = VALUES(created_at), expires_at = VALUES(expires_at)",
                cacheKey, audioUrl, mime, durationMs, engine, voiceId,
                Timestamp.from(now), Timestamp.from(expiresAt));
    }

    public void deleteTtsCache(String cacheKey) {
        jdbc.update("DELETE FROM tts_cache WHERE cache_key = ?", cacheKey);
    }

    // ---------------------------------------------------------------- asr_inputs

    /** ASR 受控输入登记（不存音频字节、不存绝对路径）。 */
    public void insertAsrInput(String id, String userId, String taskId, int sizeBytes, String sha256,
                               Instant now, Instant expiresAt) {
        jdbc.update("INSERT INTO asr_inputs (id, user_id, task_id, size_bytes, sha256, created_at, expires_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, userId, taskId, sizeBytes, sha256, Timestamp.from(now), Timestamp.from(expiresAt));
    }

    public void bindAsrTask(String id, String taskId) {
        jdbc.update("UPDATE asr_inputs SET task_id = ? WHERE id = ?", taskId, id);
    }

    /** 审计用：列出即将过期的登记（运维清理对账）。 */
    public int countAsrInputs(String userId) {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM asr_inputs WHERE user_id = ?",
                Integer.class, userId);
        return count == null ? 0 : count;
    }
}
