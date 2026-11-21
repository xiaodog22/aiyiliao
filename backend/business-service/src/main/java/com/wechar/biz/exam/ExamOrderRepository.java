package com.wechar.biz.exam;

import java.math.BigDecimal;
import java.sql.Date;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** 检查预约仓储（V35）。状态只由服务端推进；取消后不可回退。 */
@Repository
public class ExamOrderRepository {

    private final JdbcTemplate jdbc;

    public ExamOrderRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ExamOrderRow(Long id, String requestNo, String userId, String familyMemberId,
                               String patientName, String itemCode, String itemName,
                               BigDecimal price, String slotKey, String slotDate, String slotTime,
                               String status, String hisOrderNo, String source, String idemKey,
                               String lastError, Instant createdAt, Instant updatedAt,
                               Instant cancelledAt) {
    }

    public void insert(String requestNo, String userId, String familyMemberId, String patientName,
                       String itemCode, String itemName, BigDecimal price, String slotKey,
                       String slotDate, String slotTime, String hisOrderNo, String source,
                       String idemKey) {
        Instant now = Instant.now();
        jdbc.update("INSERT INTO exam_orders (request_no, user_id, family_member_id, patient_name, "
                        + "item_code, item_name, price, slot_key, slot_date, slot_time, status, "
                        + "his_order_no, source, idem_key, created_at, updated_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'BOOKED', ?, ?, ?, ?, ?)",
                requestNo, userId, familyMemberId, patientName, itemCode, itemName, price,
                slotKey, Date.valueOf(slotDate), slotTime, hisOrderNo, source, idemKey,
                Timestamp.from(now), Timestamp.from(now));
    }

    public Optional<ExamOrderRow> findByRequestNo(String requestNo) {
        return one("SELECT * FROM exam_orders WHERE request_no = ?", requestNo);
    }

    public Optional<ExamOrderRow> findByUserAndIdem(String userId, String idemKey) {
        return one("SELECT * FROM exam_orders WHERE user_id = ? AND idem_key = ?", userId, idemKey);
    }

    public List<ExamOrderRow> listByUser(String userId) {
        return jdbc.query("SELECT * FROM exam_orders WHERE user_id = ? "
                        + "ORDER BY created_at DESC LIMIT 50",
                ExamOrderRepository::mapRow, userId);
    }

    /** 取消；返回 1=本次取消，0=已取消/已完成（调用方按幂等处理）。 */
    public int markCancelled(String requestNo) {
        Instant now = Instant.now();
        return jdbc.update("UPDATE exam_orders SET status = 'CANCELLED', cancelled_at = ?, updated_at = ?, "
                        + "last_error = NULL WHERE request_no = ? AND status = 'BOOKED'",
                Timestamp.from(now), Timestamp.from(now), requestNo);
    }

    public void markError(String requestNo, String error) {
        String safe = error == null ? null : (error.length() > 255 ? error.substring(0, 255) : error);
        jdbc.update("UPDATE exam_orders SET last_error = ?, updated_at = ? WHERE request_no = ?",
                safe, Timestamp.from(Instant.now()), requestNo);
    }

    private Optional<ExamOrderRow> one(String sql, Object... args) {
        return jdbc.query(sql, ExamOrderRepository::mapRow, args).stream().findFirst();
    }

    private static ExamOrderRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        Date slotDate = rs.getDate("slot_date");
        return new ExamOrderRow(
                rs.getLong("id"),
                rs.getString("request_no"),
                rs.getString("user_id"),
                rs.getString("family_member_id"),
                rs.getString("patient_name"),
                rs.getString("item_code"),
                rs.getString("item_name"),
                rs.getBigDecimal("price"),
                rs.getString("slot_key"),
                slotDate == null ? null : slotDate.toString(),
                rs.getString("slot_time"),
                rs.getString("status"),
                rs.getString("his_order_no"),
                rs.getString("source"),
                rs.getString("idem_key"),
                rs.getString("last_error"),
                instant(rs.getTimestamp("created_at")),
                instant(rs.getTimestamp("updated_at")),
                instant(rs.getTimestamp("cancelled_at")));
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
