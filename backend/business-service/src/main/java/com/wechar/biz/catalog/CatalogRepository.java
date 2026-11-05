package com.wechar.biz.catalog;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * catalog 只读目录数据访问（departments / doctors / doctor_slots，V1 已有表）。
 * 医生列表只挂科室（契约 {departmentId}/doctors），不做全局枚举。
 */
@Component
public class CatalogRepository {

    private final JdbcTemplate jdbc;

    public CatalogRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record DepartmentRow(String id, String hospitalId, String hospitalName, String name, String location,
                                String building, String floor, String area, String roomNo,
                                String description, String iconKey) {
    }

    public record DoctorRow(String id, String departmentId, String departmentName, String name, String title,
                            String specialtiesJson, String introduction, String avatarKey) {
    }

    /**
     * V23 在线问诊「选择医生」申请模式：医生登录账号（doctors.user_id → users.id）。
     * 仅当医生存在且 ACTIVE 时返回；用于创建咨询时校验 + 向医生消息中心写 CONSULT_APPLY 通知。
     */
    public Optional<String> findDoctorUserId(String doctorId) {
        if (doctorId == null || doctorId.isBlank()) {
            return Optional.empty();
        }
        // ⚠️ 医生存在但未绑定登录账号时 user_id 为 NULL：stream 里出现 null 元素会让
        //    findFirst() 内部 Optional.of(null) 抛 NPE（2026-10-24 实测 → 创建会话 500）。
        //    必须先滤掉 null，才能让「未绑定」安静地走 404 分支。
        return jdbc.query("SELECT user_id FROM doctors WHERE id = ? AND status = 'ACTIVE'",
                (rs, n) -> rs.getString("user_id"), doctorId).stream()
                .filter(java.util.Objects::nonNull)
                .findFirst();
    }

    public record SlotRow(String id, String doctorId, Instant startTime, Instant endTime,
                          int capacity, int remaining, java.math.BigDecimal fee, String currency) {
    }

    private static DepartmentRow mapDept(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new DepartmentRow(rs.getString("id"), rs.getString("hospital_id"), rs.getString("hospital_name"),
                rs.getString("name"), rs.getString("location"), rs.getString("building"), rs.getString("floor"),
                rs.getString("area"), rs.getString("room_no"),
                rs.getString("description"), rs.getString("icon_key"));
    }

    private static final String DEPT_COLS = "id, hospital_id, hospital_name, name, location, building, floor, "
            + "area, room_no, description, icon_key";

    private static DoctorRow mapDoc(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new DoctorRow(rs.getString("id"), rs.getString("department_id"), rs.getString("department_name"),
                rs.getString("name"), rs.getString("title"), rs.getString("specialties_json"),
                rs.getString("introduction"), rs.getString("avatar_key"));
    }

    private static SlotRow mapSlot(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp s = rs.getTimestamp("start_time");
        Timestamp e = rs.getTimestamp("end_time");
        return new SlotRow(rs.getString("id"), rs.getString("doctor_id"),
                s == null ? null : s.toInstant(), e == null ? null : e.toInstant(),
                rs.getInt("capacity"), rs.getInt("remaining"), rs.getBigDecimal("fee"), rs.getString("currency"));
    }

    public List<DepartmentRow> listDepartments(String hospitalId, String keyword) {
        StringBuilder sql = new StringBuilder(
                "SELECT " + DEPT_COLS + " FROM departments WHERE status = 'ACTIVE'");
        java.util.List<Object> args = new java.util.ArrayList<>();
        if (hospitalId != null && !hospitalId.isBlank()) {
            sql.append(" AND hospital_id = ?");
            args.add(hospitalId);
        }
        if (keyword != null && !keyword.isBlank()) {
            sql.append(" AND name LIKE ?");
            args.add("%" + keyword + "%");
        }
        sql.append(" ORDER BY sort_order, id");
        return jdbc.query(sql.toString(), CatalogRepository::mapDept, args.toArray());
    }

    public boolean departmentExists(String departmentId) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM departments WHERE id = ? AND status = 'ACTIVE'",
                Integer.class, departmentId);
        return n != null && n > 0;
    }

    public Optional<DepartmentRow> findDepartment(String departmentId) {
        return jdbc.query("SELECT " + DEPT_COLS + " FROM departments WHERE id = ? AND status = 'ACTIVE'",
                CatalogRepository::mapDept, departmentId).stream().findFirst();
    }

    public List<DoctorRow> listDoctors(String departmentId, String hospitalId) {
        StringBuilder sql = new StringBuilder(
                "SELECT d.id, d.department_id, dep.name AS department_name, d.name, d.title, "
                        + "d.specialties_json, d.introduction, d.avatar_key "
                        + "FROM doctors d, departments dep "
                        + "WHERE d.department_id = dep.id AND d.status = 'ACTIVE'");
        java.util.List<Object> args = new java.util.ArrayList<>();
        if (departmentId != null && !departmentId.isBlank()) {
            sql.append(" AND d.department_id = ?");
            args.add(departmentId);
        }
        if (hospitalId != null && !hospitalId.isBlank()) {
            sql.append(" AND dep.hospital_id = ?");
            args.add(hospitalId);
        }
        sql.append(" ORDER BY d.department_id, d.id");
        return jdbc.query(sql.toString(), CatalogRepository::mapDoc, args.toArray());
    }

    public Optional<DoctorRow> findDoctor(String doctorId) {
        return jdbc.query("SELECT d.id, d.department_id, dep.name AS department_name, d.name, d.title, "
                        + "d.specialties_json, d.introduction, d.avatar_key "
                        + "FROM doctors d, departments dep WHERE d.department_id = dep.id AND d.id = ? AND d.status = 'ACTIVE'",
                CatalogRepository::mapDoc, doctorId).stream().findFirst();
    }

    public List<SlotRow> listSlots(String doctorId, Instant fromInclusive, Instant toExclusive) {
        StringBuilder sql = new StringBuilder(
                "SELECT id, doctor_id, start_time, end_time, capacity, remaining, fee, currency "
                        + "FROM doctor_slots WHERE doctor_id = ? AND status = 'OPEN'"
                        // 2026-11-04：过期号源不再下发。此前只有 status 判断，而历史 OPEN 号源不会自动关闭，
                        // 前端会把「今天 09:00」照常列出，用户选中提交后必然 422 SLOT_IN_PAST。
                        // 会话时区由连接串固定为 UTC（forceConnectionTimeZoneToSession=true），NOW(3) 与本表
                        // start_time 同为 UTC 口径，可直接比较。
                        + " AND start_time > NOW(3)");
        java.util.List<Object> args = new java.util.ArrayList<>(java.util.List.of(doctorId));
        if (fromInclusive != null) {
            sql.append(" AND start_time >= ?");
            args.add(Timestamp.from(fromInclusive));
        }
        if (toExclusive != null) {
            sql.append(" AND start_time < ?");
            args.add(Timestamp.from(toExclusive));
        }
        sql.append(" ORDER BY start_time, id");
        return jdbc.query(sql.toString(), CatalogRepository::mapSlot, args.toArray());
    }

    public boolean hasAvailableSlot(String doctorId) {
        Integer n = jdbc.queryForObject(
                // 2026-11-04：同样排除过期号源 —— 否则医生列表显示"有号"，点进去号源全过期。
                "SELECT COUNT(*) FROM doctor_slots WHERE doctor_id = ? AND status = 'OPEN' "
                        + "AND remaining > 0 AND start_time > NOW(3)",
                Integer.class, doctorId);
        return n != null && n > 0;
    }

    /**
     * 号源摘要（PERF-09，2026-11-01）：一次查出一批医生的"是否有号"+"今日剩余量"。
     *
     * 背景：{@code hasAvailableSlot} 与 {@code sumRemainingInWindow} 在
     * {@code CatalogService.toDoctorData()} 里被**逐医生**各调一次 → 20 个医生 40 次子查询，
     * 实测 1VU 无排队 P50 就 55ms（同组其它端点 6.6~12.9ms），并把全局 SQL 成本推到 20.7 次/请求。
     *
     * 两个旧方法语义不同但数据同源，可以一次扫描同时算出：
     *  - availableCount：**不限时间窗**，统计 remaining &gt; 0 的 OPEN 号源条数（对应 hasAvailableSlot）；
     *  - todayRemaining：[dayFrom, dayTo) 窗口内 OPEN 号源 remaining 合计（对应 sumRemainingInWindow）。
     *
     * 返回的 Map 只含**有 OPEN 号源**的医生；查不到 = 该医生今日无号且无任何可约号源，
     * 调用方必须按"缺失 → 无号"处理（不能默认成有号）。
     */
    public java.util.Map<String, SlotSummary> slotSummaries(java.util.List<String> doctorIds,
                                                           Instant dayFrom, Instant dayTo) {
        if (doctorIds == null || doctorIds.isEmpty()) {
            // 空列表不能拼 IN ()：MySQL/H2 都会语法报错
            return java.util.Map.of();
        }
        String placeholders = String.join(",", java.util.Collections.nCopies(doctorIds.size(), "?"));
        String sql = "SELECT doctor_id, "
                + "SUM(CASE WHEN remaining > 0 THEN 1 ELSE 0 END) AS available_count, "
                + "COALESCE(SUM(CASE WHEN start_time >= ? AND start_time < ? THEN remaining ELSE 0 END), 0) "
                + "AS today_remaining "
                + "FROM doctor_slots WHERE status = 'OPEN' AND doctor_id IN (" + placeholders + ") "
                + "GROUP BY doctor_id";
        java.util.List<Object> args = new java.util.ArrayList<>(doctorIds.size() + 2);
        args.add(Timestamp.from(dayFrom));
        args.add(Timestamp.from(dayTo));
        args.addAll(doctorIds);

        java.util.Map<String, SlotSummary> summaries = new java.util.HashMap<>();
        jdbc.query(sql, rs -> {
            summaries.put(rs.getString("doctor_id"),
                    new SlotSummary(rs.getInt("available_count"), rs.getInt("today_remaining")));
        }, args.toArray());
        return summaries;
    }

    /** 单个医生的号源摘要，见 {@link #slotSummaries}。 */
    public record SlotSummary(int availableCount, int todayRemaining) {
    }

    /**
     * N6 号源三态：窗口内（[from, to)，今日 UTC 日窗口）OPEN 号源的剩余量合计。
     * 窗口内无号或无剩余均合计为 0，由服务层归一为 FULL。
     */
    public int sumRemainingInWindow(String doctorId, Instant fromInclusive, Instant toExclusive) {
        Integer n = jdbc.queryForObject(
                "SELECT COALESCE(SUM(remaining), 0) FROM doctor_slots "
                        + "WHERE doctor_id = ? AND status = 'OPEN' AND start_time >= ? AND start_time < ?",
                Integer.class, doctorId, Timestamp.from(fromInclusive), Timestamp.from(toExclusive));
        return n == null ? 0 : n;
    }

    /** N7 院区列表：由 ACTIVE 科室归属去重派生（无科室归属的院区不可知，不臆造）。 */
    public record HospitalRow(String id, String name) {
    }

    public List<HospitalRow> listHospitals() {
        return jdbc.query("SELECT DISTINCT hospital_id, hospital_name FROM departments "
                        + "WHERE status = 'ACTIVE' ORDER BY hospital_id",
                (rs, i) -> new HospitalRow(rs.getString("hospital_id"), rs.getString("hospital_name")));
    }
}
