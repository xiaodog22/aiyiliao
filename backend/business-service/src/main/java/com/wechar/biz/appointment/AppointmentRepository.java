package com.wechar.biz.appointment;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * appointments / doctor_slots 数据访问。
 * 号源扣减唯一防线：UPDATE ... SET remaining = remaining - 1 WHERE id = ? AND remaining > 0，
 * 影响 0 行 = 号源已满（契约 SLOT_FULL → 409）。
 */
@Component
public class AppointmentRepository {

    private final JdbcTemplate jdbc;

    public AppointmentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record AppointmentRow(String id, String userId, String familyMemberId, String slotId, String doctorId,
                                 String departmentId, String patientName, byte[] contactPhoneCipher,
                                 String symptomSummary, String status, Integer queueNumber, String cancelReason,
                                 String idempotencyKey, String requestDigest, int version,
                                 Instant createdAt, Instant updatedAt) {
    }

    public record SlotRow(String id, String doctorId, Instant startTime, Instant endTime, int capacity,
                          int remaining, BigDecimal fee, String currency, String status) {
    }

    private static AppointmentRow mapAppt(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new AppointmentRow(
                rs.getString("id"), rs.getString("user_id"), rs.getString("family_member_id"),
                rs.getString("slot_id"), rs.getString("doctor_id"), rs.getString("department_id"),
                rs.getString("patient_name"), rs.getBytes("contact_phone_cipher"),
                rs.getString("symptom_summary"), rs.getString("status"),
                (Integer) rs.getObject("queue_number"), rs.getString("cancel_reason"),
                rs.getString("idempotency_key"), rs.getString("request_digest"), rs.getInt("version"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    private static final String APPT_COLS = "id, user_id, family_member_id, slot_id, doctor_id, department_id, "
            + "patient_name, contact_phone_cipher, symptom_summary, status, queue_number, cancel_reason, "
            + "idempotency_key, request_digest, version, created_at, updated_at";

    private static SlotRow mapSlot(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp s = rs.getTimestamp("start_time");
        Timestamp e = rs.getTimestamp("end_time");
        return new SlotRow(rs.getString("id"), rs.getString("doctor_id"),
                s == null ? null : s.toInstant(), e == null ? null : e.toInstant(),
                rs.getInt("capacity"), rs.getInt("remaining"), rs.getBigDecimal("fee"),
                rs.getString("currency"), rs.getString("status"));
    }

    public Optional<AppointmentRow> findById(String id) {
        return jdbc.query("SELECT " + APPT_COLS + " FROM appointments WHERE id = ?",
                AppointmentRepository::mapAppt, id).stream().findFirst();
    }

    public Optional<AppointmentRow> findByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + APPT_COLS + " FROM appointments WHERE user_id = ? AND idempotency_key = ?",
                AppointmentRepository::mapAppt, userId, key).stream().findFirst();
    }

    public Optional<SlotRow> findSlot(String slotId) {
        return jdbc.query("SELECT id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status "
                        + "FROM doctor_slots WHERE id = ?",
                AppointmentRepository::mapSlot, slotId).stream().findFirst();
    }

    /** 原子扣号（唯一防线）：影响 0 行 = 号源已满。 */
    public boolean decrementSlotRemaining(String slotId) {
        int updated = jdbc.update("UPDATE doctor_slots SET remaining = remaining - 1, updated_at = ? "
                + "WHERE id = ? AND remaining > 0", Timestamp.from(Instant.now()), slotId);
        return updated == 1;
    }

    /** 扣号失败回补（事务内路径异常时使用；正常路径事务回滚即恢复）。 */
    public void restoreSlotRemaining(String slotId) {
        jdbc.update("UPDATE doctor_slots SET remaining = remaining + 1, updated_at = ? "
                + "WHERE id = ? AND remaining < capacity", Timestamp.from(Instant.now()), slotId);
    }

    /**
     * 取消预约后的号源回补（V21 互通闭环）：患者取消 → 剩余量 +1。
     * 与 restoreSlotRemaining 同一 SQL：仅当 slot 仍 OPEN 且未满时回补
     * （capacity 上限由 WHERE remaining < capacity 保证，不会超出）。
     * 过期/关闭的号源不回补（该时段本就不可再约）。
     */
    public boolean releaseSlotRemaining(String slotId) {
        int updated = jdbc.update("UPDATE doctor_slots SET remaining = remaining + 1, updated_at = ? "
                + "WHERE id = ? AND status = 'OPEN' AND remaining < capacity",
                Timestamp.from(Instant.now()), slotId);
        return updated == 1;
    }

    public void insertAppointment(AppointmentRow row, String location, String hospitalName) {
        jdbc.update("INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, "
                        + "patient_name, contact_phone_cipher, symptom_summary, status, queue_number, cancel_reason, "
                        + "location, hospital_name, idempotency_key, request_digest, version, created_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, 1, ?)",
                row.id(), row.userId(), row.familyMemberId(), row.slotId(), row.doctorId(), row.departmentId(),
                row.patientName(), row.contactPhoneCipher(), row.symptomSummary(), row.status(),
                location, hospitalName, row.idempotencyKey(), row.requestDigest(),
                Timestamp.from(row.createdAt()));
    }

    /**
     * 乐观锁更新（PATCH）：version 不匹配 → 返回 false（409 VERSION_CONFLICT）。
     * 可更新 symptomSummary / familyMemberId / contactPhoneCipher / 状态与取消原因。
     */
    public boolean updateWithVersion(String id, int expectedVersion, String symptomSummary,
                                     String familyMemberId, byte[] contactPhoneCipher,
                                     String status, String cancelReason, Instant now) {
        int updated = jdbc.update("UPDATE appointments SET symptom_summary = ?, family_member_id = ?, "
                        + "contact_phone_cipher = ?, status = ?, cancel_reason = ?, "
                        + "version = version + 1, updated_at = ? "
                        + "WHERE id = ? AND version = ?",
                symptomSummary, familyMemberId, contactPhoneCipher, status, cancelReason,
                Timestamp.from(now), id, expectedVersion);
        return updated == 1;
    }

    public List<AppointmentRow> listByUser(String userId, String status, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + APPT_COLS + " FROM appointments WHERE user_id = ?");
        java.util.List<Object> args = new java.util.ArrayList<>(java.util.List.of(userId));
        if (status != null && !status.isBlank()) {
            sql.append(" AND status = ?");
            args.add(status);
        }
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), AppointmentRepository::mapAppt, args.toArray());
    }

    public record Stats(int upcoming, int completed, int cancelled) {
    }

    /** stats：upcoming（PENDING/CONFIRMED/CHECKED_IN 且未过期的未来预约）/ completed / cancelled 三计数。 */
    public Stats statsForUser(String userId, Instant now) {
        Integer upcoming = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE user_id = ? AND status IN ('PENDING','CONFIRMED','CHECKED_IN') "
                        + "AND slot_id IN (SELECT id FROM doctor_slots WHERE start_time >= ?)",
                Integer.class, userId, Timestamp.from(now));
        Integer completed = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE user_id = ? AND status = 'COMPLETED'",
                Integer.class, userId);
        Integer cancelled = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE user_id = ? AND status IN ('CANCELLED','EXPIRED','NO_SHOW')",
                Integer.class, userId);
        return new Stats(upcoming == null ? 0 : upcoming, completed == null ? 0 : completed,
                cancelled == null ? 0 : cancelled);
    }

    /** 最近的未来预约（home 用）。 */
    public Optional<AppointmentRow> nextUpcomingForUser(String userId, Instant now) {
        return jdbc.query("SELECT " + APPT_COLS + " FROM appointments a, doctor_slots s "
                        + "WHERE a.slot_id = s.id AND a.user_id = ? "
                        + "AND a.status IN ('PENDING','CONFIRMED') AND s.start_time >= ? "
                        + "ORDER BY s.start_time ASC, a.id ASC",
                AppointmentRepository::mapAppt, userId, Timestamp.from(now)).stream().findFirst();
    }

    /** 展示视图：预约 + 号源时间 + 医生/科室名/职称 + 患者头像 + 就诊地点（逗号内连接，见已知坑 3）。
     * V21：doctor_title（医生职称）/ patient_avatar_key（患者头像，手机号密文复用 appt.contactPhoneCipher）。 */
    public record AppointmentView(AppointmentRow appt, Instant startTime, Instant endTime,
                                  String doctorName, String doctorTitle, String departmentName,
                                  String patientAvatarKey,
                                  String location, String hospitalName) {
    }

    private static AppointmentView mapView(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        AppointmentRow a = mapAppt(rs, rowNum);
        Timestamp s = rs.getTimestamp("start_time");
        Timestamp e = rs.getTimestamp("end_time");
        return new AppointmentView(a, s == null ? null : s.toInstant(), e == null ? null : e.toInstant(),
                rs.getString("doctor_name"), rs.getString("doctor_title"), rs.getString("department_name"),
                rs.getString("patient_avatar_key"),
                rs.getString("location"), rs.getString("hospital_name"));
    }

    private static final String VIEW_SELECT = "SELECT "
            + "a.id, a.user_id, a.family_member_id, a.slot_id, a.doctor_id, a.department_id, a.patient_name, "
            + "a.contact_phone_cipher, a.symptom_summary, a.status, a.queue_number, a.cancel_reason, "
            + "a.idempotency_key, a.request_digest, a.version, a.created_at, a.updated_at, "
            + "s.start_time, s.end_time, d.name AS doctor_name, d.title AS doctor_title, dep.name AS department_name, "
            + "u.avatar_key AS patient_avatar_key, "
            + "COALESCE(a.location, dep.location) AS location, "
            + "COALESCE(a.hospital_name, dep.hospital_name) AS hospital_name "
            + "FROM appointments a "
            + "JOIN doctor_slots s ON a.slot_id = s.id "
            + "JOIN doctors d ON a.doctor_id = d.id "
            + "JOIN departments dep ON d.department_id = dep.id "
            // 重要：必须以 WHERE 锚点收尾。若直接以 JOIN 结尾，后续拼接的 "AND a.x = ?"
            // 会被 SQL 解析器吞进 LEFT JOIN 的 ON 子句（只影响 join 匹配、不过滤主表行），
            // 造成"医生查到自己科室外挂号 / 按 id 查询返回全表"的数据越权（M5 分页 E2E 暴露）。
            + "LEFT JOIN users u ON a.user_id = u.id WHERE 1=1 ";

    public Optional<AppointmentView> findViewById(String id) {
        return jdbc.query(VIEW_SELECT + " AND a.id = ?", AppointmentRepository::mapView, id).stream().findFirst();
    }

    /** 契约 by-idempotency-key：user_id 参与条件（仅当前用户），无则 empty（调用方转 404）。 */
    public Optional<AppointmentView> findViewByIdempotencyKey(String userId, String key) {
        return jdbc.query(VIEW_SELECT + " AND a.user_id = ? AND a.idempotency_key = ?",
                AppointmentRepository::mapView, userId, key).stream().findFirst();
    }

    public List<AppointmentView> listViewByUser(String userId, String status, int limit) {
        StringBuilder sql = new StringBuilder(VIEW_SELECT + " AND a.user_id = ?");
        java.util.List<Object> args = new java.util.ArrayList<>(java.util.List.of(userId));
        if (status != null && !status.isBlank()) {
            sql.append(" AND a.status = ?");
            args.add(status);
        }
        sql.append(" ORDER BY s.start_time DESC, a.id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), AppointmentRepository::mapView, args.toArray());
    }

    public Optional<AppointmentView> nextUpcomingViewForUser(String userId, Instant now) {
        return jdbc.query(VIEW_SELECT + " AND a.user_id = ? AND a.status IN ('PENDING','CONFIRMED') "
                        + "AND s.start_time >= ? ORDER BY s.start_time ASC, a.id ASC",
                AppointmentRepository::mapView, userId, Timestamp.from(now)).stream().findFirst();
    }

    // =====================================================================
    // M3：医生端列表 / 状态流转与事件（契约 listDoctorAppointments、updateAppointmentStatus）
    // =====================================================================

    /**
     * 契约 listDoctorAppointments：范围裁剪在 SQL 条件内（doctor_id = ?），
     * 支持 status?、date?（调用方给 UTC 日窗口）、cursor?（按 (start_time, id) 定位，新→旧）。
     */
    public List<AppointmentView> listViewByDoctor(String doctorId, String status, Instant dayFromInclusive,
                                                  Instant dayToExclusive, Instant cursorTime, String cursorId,
                                                  int limit) {
        StringBuilder sql = new StringBuilder(VIEW_SELECT + " AND a.doctor_id = ?");
        java.util.List<Object> args = new java.util.ArrayList<>(java.util.List.of(doctorId));
        if (status != null && !status.isBlank()) {
            sql.append(" AND a.status = ?");
            args.add(status);
        }
        if (dayFromInclusive != null) {
            sql.append(" AND s.start_time >= ?");
            args.add(toDbTimestamp(dayFromInclusive));
        }
        if (dayToExclusive != null) {
            sql.append(" AND s.start_time < ?");
            args.add(toDbTimestamp(dayToExclusive));
        }
        if (cursorTime != null) {
            sql.append(" AND (s.start_time < ? OR (s.start_time = ? AND a.id < ?))");
            args.add(toDbTimestamp(cursorTime));
            args.add(toDbTimestamp(cursorTime));
            args.add(cursorId);
        }
        sql.append(" ORDER BY s.start_time DESC, a.id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), AppointmentRepository::mapView, args.toArray());
    }

    /**
     * 将 Instant 转为与读取侧自洽的 DB 参数（DATETIME 钟面语义）。
     *
     * <p>读取侧 {@code rs.getTimestamp(...).toInstant()} 会把存储的 DATETIME 钟面值按 JVM
     * 本地时区解释后再转 UTC Instant（东八区下 '09:00' → 01:00Z）；SQL 比较参数若直接用
     * {@code Timestamp.from(instant)}（UTC 值 01:00），在东八区 JVM 与存储钟面 09:00 相比
     * 会整体错位 8 小时，导致 date 窗口与 keyset 游标失效（M5 分页 E2E 在东八区暴露）。
     * 经 {@code instant.atZone(系统时区)} 还原为钟面后参数与存储同语义，任何时区均自洽。
     */
    private static Timestamp toDbTimestamp(Instant instant) {
        return Timestamp.valueOf(instant.atZone(java.time.ZoneId.systemDefault()).toLocalDateTime());
    }

    /** 状态流转乐观锁：仅改 status + version+1；0 行 = version 不匹配（调用方转 409）。 */
    public boolean updateStatusWithVersion(String id, int expectedVersion, String toStatus, Instant now) {
        int updated = jdbc.update("UPDATE appointments SET status = ?, version = version + 1, updated_at = ? "
                        + "WHERE id = ? AND version = ?",
                toStatus, Timestamp.from(now), id, expectedVersion);
        return updated == 1;
    }

    /** 状态流转事件（契约：记录操作者、时间与服务端时间戳；只追加不可变）。 */
    public record StatusEventRow(String id, String appointmentId, String fromStatus, String toStatus,
                                 String operatorUserId, String operatorDoctorId, String note, int versionAfter,
                                 Instant serverTime, String requestDigest) {
    }

    /** 幂等重放凭据：该操作者在该键下已落的事件（同键异载荷 → 409）。 */
    public Optional<StatusEventRow> findStatusEvent(String operatorUserId, String idempotencyKey) {
        return jdbc.query("SELECT id, appointment_id, from_status, to_status, operator_user_id, "
                        + "operator_doctor_id, note, version_after, server_time, request_digest "
                        + "FROM appointment_status_events WHERE operator_user_id = ? AND idempotency_key = ?",
                (rs, i) -> {
                    Timestamp server = rs.getTimestamp("server_time");
                    return new StatusEventRow(rs.getString("id"), rs.getString("appointment_id"),
                            rs.getString("from_status"), rs.getString("to_status"), rs.getString("operator_user_id"),
                            rs.getString("operator_doctor_id"), rs.getString("note"), rs.getInt("version_after"),
                            server == null ? null : server.toInstant(), rs.getString("request_digest"));
                }, operatorUserId, idempotencyKey).stream().findFirst();
    }

    public void insertStatusEvent(StatusEventRow row, String idempotencyKey, String requestDigest) {
        jdbc.update("INSERT INTO appointment_status_events (id, appointment_id, from_status, to_status, "
                        + "operator_user_id, operator_doctor_id, note, version_after, idempotency_key, "
                        + "request_digest, server_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.appointmentId(), row.fromStatus(), row.toStatus(), row.operatorUserId(),
                row.operatorDoctorId(), row.note(), row.versionAfter(), idempotencyKey, requestDigest,
                Timestamp.from(row.serverTime()));
    }

    /**
     * N10 注销 409 判定：该用户未完成的预约（PENDING/CONFIRMED/CHECKED_IN）计数。
     * 终态（COMPLETED/CANCELLED/NO_SHOW/EXPIRED）不阻塞注销。
     */
    public int countUnfinishedForUser(String userId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE user_id = ? "
                        + "AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')",
                Integer.class, userId);
        return n == null ? 0 : n;
    }
}
