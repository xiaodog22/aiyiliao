package com.wechar.biz.payment;

import java.math.BigDecimal;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** 演示支付订单仓储（V34）。金额/状态均由服务端写入，不接受客户端直改。 */
@Repository
public class PaymentOrderRepository {

    private final JdbcTemplate jdbc;

    public PaymentOrderRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record PaymentOrderRow(Long id, String orderNo, String userId, String appointmentId,
                                  String chargeNo, BigDecimal amount, String currency, String status,
                                  String source, String idemKey, String lastError,
                                  Instant createdAt, Instant updatedAt, Instant paidAt,
                                  Instant refundedAt, String refundReason, String refundChannel) {
    }

    public void insert(String orderNo, String userId, String appointmentId, String chargeNo,
                       BigDecimal amount, String currency, String status, String source, String idemKey) {
        Instant now = Instant.now();
        jdbc.update("INSERT INTO payment_orders (order_no, user_id, appointment_id, charge_no, amount, "
                        + "currency, status, source, idem_key, created_at, updated_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                orderNo, userId, appointmentId, chargeNo, amount, currency, status, source, idemKey,
                Timestamp.from(now), Timestamp.from(now));
    }

    public Optional<PaymentOrderRow> findByOrderNo(String orderNo) {
        return one("SELECT * FROM payment_orders WHERE order_no = ?", orderNo);
    }

    public Optional<PaymentOrderRow> findByUserAndIdem(String userId, String idemKey) {
        return one("SELECT * FROM payment_orders WHERE user_id = ? AND idem_key = ?", userId, idemKey);
    }

    public Optional<PaymentOrderRow> findByAppointment(String appointmentId) {
        return one("SELECT * FROM payment_orders WHERE appointment_id = ?", appointmentId);
    }

    public Optional<PaymentOrderRow> findByChargeNo(String chargeNo) {
        return one("SELECT * FROM payment_orders WHERE charge_no = ?", chargeNo);
    }

    /** 置 PAID；返回 1=本次入账，0=已是 PAID（并发/重复回调均按幂等处理）。 */
    public int markPaid(String orderNo) {
        Instant now = Instant.now();
        return jdbc.update("UPDATE payment_orders SET status = 'PAID', paid_at = ?, updated_at = ?, "
                        + "last_error = NULL WHERE order_no = ? AND status <> 'PAID'",
                Timestamp.from(now), Timestamp.from(now), orderNo);
    }

    /** 置 REFUNDED（仅 PAID 可退）；返回 1=本次退费生效，0=状态已变或已退。 */
    public int markRefunded(String orderNo, String reason, String channel) {
        Instant now = Instant.now();
        String safe = reason == null ? null : (reason.length() > 255 ? reason.substring(0, 255) : reason);
        return jdbc.update("UPDATE payment_orders SET status = 'REFUNDED', refunded_at = ?, "
                        + "refund_reason = ?, refund_channel = ?, updated_at = ? "
                        + "WHERE order_no = ? AND status = 'PAID'",
                Timestamp.from(now), safe, channel, Timestamp.from(now), orderNo);
    }

    public void markError(String orderNo, String error) {        String safe = error == null ? null : (error.length() > 255 ? error.substring(0, 255) : error);
        jdbc.update("UPDATE payment_orders SET last_error = ?, updated_at = ? "
                        + "WHERE order_no = ? AND status <> 'PAID'",
                safe, Timestamp.from(Instant.now()), orderNo);
    }

    /**
     * 对账视野（L5）：PAID + REFUNDED 两类都纳入。
     *
     * <p>原实现只查 PAID，退费后订单直接退出对账视野，HIS 侧账单恒 PAID 却无人发现。
     * 窗口按各自最近状态时间判定：PAID 看 paid_at，REFUNDED 看 refunded_at。
     */
    public List<PaymentOrderRow> listReconcilableSince(Instant since) {
        return jdbc.query("SELECT * FROM payment_orders WHERE "
                        + "(status = 'PAID' AND paid_at >= ?) OR (status = 'REFUNDED' AND refunded_at >= ?) "
                        + "ORDER BY updated_at DESC LIMIT 200",
                PaymentOrderRepository::mapRow, Timestamp.from(since), Timestamp.from(since));
    }

    private Optional<PaymentOrderRow> one(String sql, Object... args) {
        return jdbc.query(sql, PaymentOrderRepository::mapRow, args).stream().findFirst();
    }

    private static PaymentOrderRow mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new PaymentOrderRow(
                rs.getLong("id"),
                rs.getString("order_no"),
                rs.getString("user_id"),
                rs.getString("appointment_id"),
                rs.getString("charge_no"),
                rs.getBigDecimal("amount"),
                rs.getString("currency"),
                rs.getString("status"),
                rs.getString("source"),
                rs.getString("idem_key"),
                rs.getString("last_error"),
                instant(rs.getTimestamp("created_at")),
                instant(rs.getTimestamp("updated_at")),
                instant(rs.getTimestamp("paid_at")),
                instant(rs.getTimestamp("refunded_at")),
                rs.getString("refund_reason"),
                rs.getString("refund_channel"));
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }
}
