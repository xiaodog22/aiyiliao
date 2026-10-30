package com.wechar.biz.patient;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** health_records 数据访问（V3）。幂等：(user_id, idempotency_key) 唯一。 */
@Component
public class HealthRecordRepository {

    private final JdbcTemplate jdbc;

    public HealthRecordRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record HealthRecordRow(String id, String userId, String familyMemberId, String category,
                                  String title, String summary, Instant recordedAt,
                                  String source, String doctorName, Boolean abnormal,
                                  String reportStatus, String hospital, int version,
                                  String idempotencyKey, String requestDigest,
                                  Instant createdAt, Instant updatedAt) {
    }

    /** abnormal 为 TINYINT(1)：MySQL 返回 Boolean、H2 返回 Number，统一"非零即真"；NULL 保留为未判定。 */
    private static Boolean toBoolean(Object raw) {
        if (raw == null) {
            return null;
        }
        if (raw instanceof Boolean bool) {
            return bool;
        }
        return ((Number) raw).intValue() != 0;
    }

    private static HealthRecordRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp rec = rs.getTimestamp("recorded_at");
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new HealthRecordRow(rs.getString("id"), rs.getString("user_id"),
                rs.getString("family_member_id"), rs.getString("category"), rs.getString("title"),
                rs.getString("summary"), rec == null ? null : rec.toInstant(),
                rs.getString("source"), rs.getString("doctor_name"), toBoolean(rs.getObject("abnormal")),
                rs.getString("report_status"), rs.getString("hospital"),
                rs.getInt("version"),
                rs.getString("idempotency_key"), rs.getString("request_digest"),
                created == null ? null : created.toInstant(), updated == null ? null : updated.toInstant());
    }

    private static final String COLS = "id, user_id, family_member_id, category, title, summary, "
            + "recorded_at, source, doctor_name, abnormal, report_status, hospital, version, "
            + "idempotency_key, request_digest, created_at, updated_at";

    public Optional<HealthRecordRow> findById(String userId, String id) {
        return jdbc.query("SELECT " + COLS + " FROM health_records WHERE id = ? AND user_id = ?",
                HealthRecordRepository::map, id, userId).stream().findFirst();
    }

    public Optional<HealthRecordRow> findByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + COLS + " FROM health_records WHERE user_id = ? AND idempotency_key = ?",
                HealthRecordRepository::map, userId, key).stream().findFirst();
    }

    public List<HealthRecordRow> list(String userId, String familyMemberId, int limit) {
        if (familyMemberId == null || familyMemberId.isBlank()) {
            return jdbc.query("SELECT " + COLS + " FROM health_records WHERE user_id = ? "
                            + "AND family_member_id IS NULL ORDER BY recorded_at DESC, id DESC LIMIT ?",
                    HealthRecordRepository::map, userId, limit);
        }
        return jdbc.query("SELECT " + COLS + " FROM health_records WHERE user_id = ? AND family_member_id = ? "
                        + "ORDER BY recorded_at DESC, id DESC LIMIT ?",
                HealthRecordRepository::map, userId, familyMemberId, limit);
    }

    public void insert(HealthRecordRow row) {
        jdbc.update("INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, "
                        + "recorded_at, source, doctor_name, abnormal, report_status, hospital, version, "
                        + "idempotency_key, request_digest, created_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                row.id(), row.userId(), row.familyMemberId(), row.category(), row.title(), row.summary(),
                Timestamp.from(row.recordedAt()), row.source(), row.doctorName(), row.abnormal(),
                row.reportStatus(), row.hospital(),
                row.idempotencyKey(), row.requestDigest(), Timestamp.from(row.createdAt()));
    }

    /** version 乐观锁更新；0 行 = 版本冲突。 */
    public boolean update(String userId, String id, int expectedVersion, String category, String title,
                          String summary, Instant recordedAt, Instant now) {
        int updated = jdbc.update("UPDATE health_records SET category = ?, title = ?, summary = ?, "
                        + "recorded_at = ?, version = version + 1, updated_at = ? "
                        + "WHERE id = ? AND user_id = ? AND version = ?",
                category, title, summary, Timestamp.from(recordedAt), Timestamp.from(now),
                id, userId, expectedVersion);
        return updated == 1;
    }

    public boolean delete(String userId, String id) {
        return jdbc.update("DELETE FROM health_records WHERE id = ? AND user_id = ?", id, userId) == 1;
    }
}
