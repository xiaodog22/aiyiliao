package com.wechar.biz.doctor;

import java.sql.Time;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalTime;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 排班与在线状态仓储（V22，2026-10-22）。
 *
 * 两个事实源：
 *  - doctor_schedules：周模板（一名医生一天可有多段），**整体替换**写入；
 *  - doctor_online_status：实时开关（单行/医生），upsert。
 *
 * version 口径：排班的 version 是**医生级**（同一医生所有行共享），取 MAX(version)，
 * 无排班视为 0；在线状态另有自己的 version（每次开关 +1）。
 */
@Repository
public class DoctorScheduleRepository {

    private final JdbcTemplate jdbc;

    public DoctorScheduleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 一行排班（times 为本地墙上时间，不含时区）。 */
    public record ScheduleRow(String id, String doctorId, int weekday, LocalTime startTime, LocalTime endTime,
                              int slotMinutes, int capacity, boolean onlineOnly, int version) {
    }

    /** 在线状态行。 */
    public record OnlineRow(String doctorId, boolean online, boolean accepting, int version, Instant updatedAt) {
    }

    public List<ScheduleRow> findByDoctorId(String doctorId) {
        return jdbc.query("""
                        SELECT id, doctor_id, weekday, start_time, end_time, slot_minutes, capacity,
                               online_only, version
                          FROM doctor_schedules
                         WHERE doctor_id = ?
                         ORDER BY weekday, start_time
                        """,
                (rs, i) -> new ScheduleRow(
                        rs.getString("id"), rs.getString("doctor_id"), rs.getInt("weekday"),
                        toLocalTime(rs.getTime("start_time")), toLocalTime(rs.getTime("end_time")),
                        rs.getInt("slot_minutes"), rs.getInt("capacity"),
                        rs.getBoolean("online_only"), rs.getInt("version")),
                doctorId);
    }

    /** 当前医生级排班版本；无排班 → 0（客户端首次保存传 expectedVersion=0）。 */
    public int currentVersion(String doctorId) {
        Integer max = jdbc.queryForObject(
                "SELECT COALESCE(MAX(version), 0) FROM doctor_schedules WHERE doctor_id = ?",
                Integer.class, doctorId);
        return max == null ? 0 : max;
    }

    /**
     * 整体替换：删掉该医生全部旧行后批量写入（同一事务内，由 Service 保证 @Transactional）。
     * 不做增量补丁——周模板的语义就是"以请求为准"。
     */
    public void replaceAll(String doctorId, int version, List<ScheduleRow> rows) {
        jdbc.update("DELETE FROM doctor_schedules WHERE doctor_id = ?", doctorId);
        if (rows.isEmpty()) {
            return;
        }
        jdbc.batchUpdate("""
                        INSERT INTO doctor_schedules
                            (id, doctor_id, weekday, start_time, end_time, slot_minutes, capacity,
                             online_only, version, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
                        """,
                rows.stream().map(r -> new Object[]{
                        r.id() == null ? "sched-" + UUID.randomUUID() : r.id(),
                        doctorId, r.weekday(), Time.valueOf(r.startTime()), Time.valueOf(r.endTime()),
                        r.slotMinutes(), r.capacity(), r.onlineOnly(), version
                }).toList());
    }

    public Optional<OnlineRow> findOnline(String doctorId) {
        List<OnlineRow> rows = jdbc.query("""
                        SELECT doctor_id, online, accepting, version, updated_at
                          FROM doctor_online_status
                         WHERE doctor_id = ?
                        """,
                (rs, i) -> new OnlineRow(
                        rs.getString("doctor_id"), rs.getBoolean("online"), rs.getBoolean("accepting"),
                        rs.getInt("version"), toInstant(rs.getTimestamp("updated_at"))),
                doctorId);
        return rows.stream().findFirst();
    }

    /** upsert 在线状态：version 自增（无行时插入 version=1）。 */
    public void upsertOnline(String doctorId, boolean online, boolean accepting) {
        jdbc.update("""
                        INSERT INTO doctor_online_status (doctor_id, online, accepting, version, updated_at)
                        VALUES (?, ?, ?, 1, CURRENT_TIMESTAMP(3))
                        ON DUPLICATE KEY UPDATE
                            online = VALUES(online),
                            accepting = VALUES(accepting),
                            version = version + 1,
                            updated_at = CURRENT_TIMESTAMP(3)
                        """,
                doctorId, online, accepting);
    }

    private static LocalTime toLocalTime(Time time) {
        return time == null ? null : time.toLocalTime();
    }

    private static Instant toInstant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
