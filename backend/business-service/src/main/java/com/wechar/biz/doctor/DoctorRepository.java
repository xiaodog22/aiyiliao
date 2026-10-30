package com.wechar.biz.doctor;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 医生任职关系与工作台计数（V1 已有 doctors / appointments / doctor_slots 表）。
 * 契约 doctorLogin："角色只能由服务端根据数据库中的任职关系判定，医生身份需院方预先登记"
 * —— 判定依据 = doctors.user_id 指向当前用户且 doctors.status='ACTIVE'。
 */
@Component
public class DoctorRepository {

    private final JdbcTemplate jdbc;

    public DoctorRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 医生的任职行（id/科室/姓名/职称），departmentName 供工作台与范围展示。 */
    public record DoctorRow(String id, String departmentId, String departmentName, String name, String title) {
    }

    private static final String DOCTOR_SELECT =
            "SELECT d.id, d.department_id, dep.name AS department_name, d.name, d.title "
                    + "FROM doctors d, departments dep "
                    + "WHERE d.department_id = dep.id AND d.user_id = ? AND d.status = 'ACTIVE'";

    /** 当前登录账号的医生任职（无任职 → empty，调用方按契约 403 处理）。 */
    public Optional<DoctorRow> findActiveByUserId(String userId) {
        if (userId == null || userId.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query(DOCTOR_SELECT, (rs, i) -> new DoctorRow(rs.getString("id"),
                        rs.getString("department_id"), rs.getString("department_name"),
                        rs.getString("name"), rs.getString("title")), userId)
                .stream().findFirst();
    }

    /** 是否具备医生任职（User.roles 的 DOCTOR 判定，与 findActiveByUserId 同一依据）。 */
    public boolean hasActiveDoctor(String userId) {
        return findActiveByUserId(userId).isPresent();
    }

    /**
     * V21 医生自述资料（GET /doctor/me）：任职行 + 工号（V11 列，未登记为 null）。
     * 与 findActiveByUserId 同一任职判定（user_id + ACTIVE），只是多取 employee_no。
     */
    public record DoctorProfileRow(String id, String userId, String employeeNo, String departmentId,
                                   String departmentName, String name, String title) {
    }

    public Optional<DoctorProfileRow> findProfileByUserId(String userId) {
        if (userId == null || userId.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query("SELECT d.id, d.user_id, d.employee_no, d.department_id, "
                        + "dep.name AS department_name, d.name, d.title "
                        + "FROM doctors d, departments dep "
                        + "WHERE d.department_id = dep.id AND d.user_id = ? AND d.status = 'ACTIVE'",
                (rs, i) -> new DoctorProfileRow(rs.getString("id"), rs.getString("user_id"),
                        rs.getString("employee_no"), rs.getString("department_id"),
                        rs.getString("department_name"), rs.getString("name"), rs.getString("title")),
                userId).stream().findFirst();
    }

    /**
     * N8 账号登录：按工号（doctors.employee_no，V11 新增）定位已登记任职的登录账号。
     * 无任职 / 未绑定账号（user_id 为空）→ empty，调用方按契约 401 处理（不泄露工号是否存在）。
     */
    public Optional<String> findActiveUserIdByEmployeeNo(String employeeNo) {
        if (employeeNo == null || employeeNo.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query("SELECT user_id FROM doctors "
                        + "WHERE employee_no = ? AND status = 'ACTIVE' AND user_id IS NOT NULL",
                (rs, i) -> rs.getString("user_id"), employeeNo).stream().findFirst();
    }

    /**
     * 今日该医生号源下的挂号总数（时间窗由调用方按 UTC 日边界给出，避免本地时区歧义）。
     */
    public int countAppointmentsInWindow(String doctorId, Instant fromInclusive, Instant toExclusive) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments a, doctor_slots s "
                        + "WHERE a.slot_id = s.id AND a.doctor_id = ? "
                        + "AND s.start_time >= ? AND s.start_time < ?",
                Integer.class, doctorId, Timestamp.from(fromInclusive), Timestamp.from(toExclusive));
        return n == null ? 0 : n;
    }

    /** 今日窗口内指定状态的挂号数（waitingPatients / pendingReviews 两个解释性口径共用）。 */
    public int countAppointmentsByStatusInWindow(String doctorId, Instant fromInclusive, Instant toExclusive,
                                                 String... statuses) {
        StringBuilder sql = new StringBuilder(
                "SELECT COUNT(*) FROM appointments a, doctor_slots s "
                        + "WHERE a.slot_id = s.id AND a.doctor_id = ? "
                        + "AND s.start_time >= ? AND s.start_time < ? AND a.status IN (");
        for (int i = 0; i < statuses.length; i++) {
            sql.append(i == 0 ? "?" : ", ?");
        }
        sql.append(")");
        Object[] args = new Object[3 + statuses.length];
        args[0] = doctorId;
        args[1] = Timestamp.from(fromInclusive);
        args[2] = Timestamp.from(toExclusive);
        System.arraycopy(statuses, 0, args, 3, statuses.length);
        Integer n = jdbc.queryForObject(sql.toString(), Integer.class, args);
        return n == null ? 0 : n;
    }

    /**
     * V21 问诊待回复数（todos 的 CONSULT_REPLY，可判定口径）：
     * 该医生名下 ACTIVE 会话中，**末条消息来自患者**（role='user' 且其后无非用户消息）的会话数。
     * 不设日期窗口：昨天起未回复的问诊今天仍待回复（与 CHECKIN_CONFIRM 的今日口径不同）。
     * 无医生归属（doctor_id 为空）的历史会话不计入——归属不明时服务端不可判定，不猜。
     */
    public int countConsultationsAwaitingReply(String doctorId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(DISTINCT c.id) FROM consultations c "
                        + "JOIN consultation_messages m ON m.consultation_id = c.id "
                        + "WHERE c.doctor_id = ? AND c.status = 'ACTIVE' AND m.role = 'user' "
                        + "AND NOT EXISTS (SELECT 1 FROM consultation_messages m2 "
                        + "  WHERE m2.consultation_id = c.id AND m2.role <> 'user' "
                        + "  AND (m2.created_at > m.created_at "
                        + "   OR (m2.created_at = m.created_at AND m2.id > m.id)))",
                Integer.class, doctorId);
        return n == null ? 0 : n;
    }
}
