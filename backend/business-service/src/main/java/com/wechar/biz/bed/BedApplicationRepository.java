package com.wechar.biz.bed;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * bed_applications 数据访问（申请制，V29）。
 *
 * 查询一律 LEFT JOIN：病区/床位为可选项，只申请病区的申请单没有 bed_id。
 * 幂等以 idempotency_key 唯一索引兜底（同键不同载荷由 Service 比对 request_digest）。
 */
@Component
public class BedApplicationRepository {

    private final JdbcTemplate jdbc;

    public BedApplicationRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ApplicationRow(String id, String doctorId, String doctorName, String departmentId,
                                 String wardId, String wardName, String bedId, String bedLabel,
                                 String patientRef, String patientDisplayName, String reason,
                                 String priority, String status, String reviewNote, Instant reviewedAt,
                                 Instant createdAt, String idempotencyKey, String requestDigest) {
    }

    private static final String SELECT =
            "SELECT a.id, a.doctor_id, d.name AS doctor_name, a.department_id, a.ward_id, w.name AS ward_name, "
                    + "a.bed_id, b.label AS bed_label, a.patient_ref, a.patient_display_name, a.reason, a.priority, "
                    + "a.status, a.review_note, a.reviewed_at, a.created_at, a.idempotency_key, a.request_digest "
                    + "FROM bed_applications a "
                    + "LEFT JOIN doctors d ON d.id = a.doctor_id "
                    + "LEFT JOIN wards w ON w.id = a.ward_id "
                    + "LEFT JOIN beds b ON b.id = a.bed_id ";

    private static ApplicationRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp reviewed = rs.getTimestamp("reviewed_at");
        Timestamp created = rs.getTimestamp("created_at");
        return new ApplicationRow(rs.getString("id"), rs.getString("doctor_id"), rs.getString("doctor_name"),
                rs.getString("department_id"), rs.getString("ward_id"), rs.getString("ward_name"),
                rs.getString("bed_id"), rs.getString("bed_label"), rs.getString("patient_ref"),
                rs.getString("patient_display_name"), rs.getString("reason"), rs.getString("priority"),
                rs.getString("status"), rs.getString("review_note"),
                reviewed == null ? null : reviewed.toInstant(),
                created == null ? null : created.toInstant(),
                rs.getString("idempotency_key"), rs.getString("request_digest"));
    }

    public void insert(String id, String doctorId, String departmentId, String wardId, String bedId,
                       String patientRef, String patientDisplayName, String reason, String priority,
                       String status, String idempotencyKey, String requestDigest, Instant now) {
        jdbc.update("INSERT INTO bed_applications (id, doctor_id, department_id, ward_id, bed_id, patient_ref, "
                        + "patient_display_name, reason, priority, status, idempotency_key, request_digest, "
                        + "created_at, updated_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, doctorId, departmentId, wardId, bedId, patientRef, patientDisplayName, reason, priority,
                status, idempotencyKey, requestDigest, Timestamp.from(now), Timestamp.from(now));
    }

    /** 医生自己的申请（按创建时间倒序）；status 为空 → 全部状态。 */
    public List<ApplicationRow> listByDoctor(String doctorId, String status, int limit) {
        if (status == null || status.isBlank()) {
            return jdbc.query(SELECT + "WHERE a.doctor_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT ?",
                    BedApplicationRepository::map, doctorId, limit);
        }
        return jdbc.query(SELECT + "WHERE a.doctor_id = ? AND a.status = ? "
                        + "ORDER BY a.created_at DESC, a.id DESC LIMIT ?",
                BedApplicationRepository::map, doctorId, status, limit);
    }

    /** 护士站视角：按状态列全院申请（dev 管理端点使用）。 */
    public List<ApplicationRow> listByStatus(String status, int limit) {
        if (status == null || status.isBlank()) {
            return jdbc.query(SELECT + "ORDER BY a.created_at ASC, a.id ASC LIMIT ?",
                    BedApplicationRepository::map, limit);
        }
        return jdbc.query(SELECT + "WHERE a.status = ? ORDER BY a.created_at ASC, a.id ASC LIMIT ?",
                BedApplicationRepository::map, status, limit);
    }

    /** 护士站终端：按状态 + 病区列待审申请（2026-11-19）。 */
    public List<ApplicationRow> listByStatusAndWard(String status, String wardId, int limit) {
        if (status == null || status.isBlank()) {
            return jdbc.query(SELECT + "WHERE a.ward_id = ? ORDER BY a.created_at ASC, a.id ASC LIMIT ?",
                    BedApplicationRepository::map, wardId, limit);
        }
        return jdbc.query(SELECT + "WHERE a.status = ? AND a.ward_id = ? "
                        + "ORDER BY a.created_at ASC, a.id ASC LIMIT ?",
                BedApplicationRepository::map, status, wardId, limit);
    }

    public Optional<ApplicationRow> findById(String id) {
        return jdbc.query(SELECT + "WHERE a.id = ?", BedApplicationRepository::map, id).stream().findFirst();
    }

    public Optional<ApplicationRow> findByIdempotencyKey(String key) {
        return jdbc.query(SELECT + "WHERE a.idempotency_key = ?", BedApplicationRepository::map, key)
                .stream().findFirst();
    }

    /**
     * 护士站排床（2026-11-19）：只允许对 PENDING 申请写 bed_id。
     * 与审批同事务调用；若申请已被他人处理，返回 false，由调用方转 409。
     */
    public boolean assignBed(String id, String bedId, Instant now) {
        int updated = jdbc.update("UPDATE bed_applications SET bed_id = ?, updated_at = ? "
                        + "WHERE id = ? AND status = 'PENDING'",
                bedId, Timestamp.from(now), id);
        return updated == 1;
    }

    /** 审批落定：仅当仍是 PENDING 才写入（并发下第二个审批人拿不到行 → 409）。 */
    public boolean review(String id, String status, String reviewNote, String reviewer, Instant now) {
        int updated = jdbc.update("UPDATE bed_applications SET status = ?, review_note = ?, reviewer = ?, "
                        + "reviewed_at = ?, updated_at = ? WHERE id = ? AND status = 'PENDING'",
                status, reviewNote, reviewer, Timestamp.from(now), Timestamp.from(now), id);
        return updated == 1;
    }

    public int countPendingByDoctor(String doctorId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM bed_applications WHERE doctor_id = ? AND status = 'PENDING'",
                Integer.class, doctorId);
        return n == null ? 0 : n;
    }
}
