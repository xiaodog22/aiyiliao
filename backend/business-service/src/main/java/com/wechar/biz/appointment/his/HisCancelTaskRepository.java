package com.wechar.biz.appointment.his;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * HIS 撤销补偿 outbox（L5，2026-11-22）。
 *
 * <p>为什么不是「失败再入队」：若先调用 HIS 撤销再落库，进程在两者之间崩溃就永久丢失补偿线索。
 * 因此本地取消事务内**先入队**，再尝试撤销；成功即置 DONE。入队失败会回滚整个取消
 * （宁可取消失败重试，也不出现「平台已取消、医院仍有单且无人知道」）。
 *
 * <p>退避由 {@link HisCancelRetryJob} 计算，本类只持久化状态。
 */
@Repository
public class HisCancelTaskRepository {

    static final int LIST_LIMIT = 50;

    private final JdbcTemplate jdbc;

    public HisCancelTaskRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record Task(Long id, String appointmentId, String hisOrderNo, String reason, int attempts) {
    }

    /** 幂等入队：同预约重复取消/重复调用不重置已累积的退避进度。 */
    public void enqueue(String appointmentId, String hisOrderNo, String reason, Instant now) {
        try {
            jdbc.update("INSERT INTO his_cancel_tasks (appointment_id, his_order_no, reason, status, "
                            + "attempts, next_retry_at, created_at, updated_at) "
                            + "VALUES (?, ?, ?, 'PENDING', 0, ?, ?, ?)",
                    appointmentId, hisOrderNo, safeReason(reason),
                    Timestamp.from(now), Timestamp.from(now), Timestamp.from(now));
        } catch (DuplicateKeyException ignored) {
            // 已存在未完成任务：保持原退避进度（重复取消不应把重试次数清零）
        }
    }

    /**
     * 独立事务入队（L5，2026-11-22）：用于「本地预约落单失败、外层事务必然回滚」的补偿。
     * 新事务先提交补偿任务，再让外层失败回滚，避免撤销线索随预约一起消失。
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void enqueueIndependent(String appointmentId, String hisOrderNo, String reason, Instant now) {
        enqueue(appointmentId, hisOrderNo, reason, now);
    }

    public List<Task> listDue(Instant now) {        return jdbc.query("SELECT id, appointment_id, his_order_no, reason, attempts FROM his_cancel_tasks "
                        + "WHERE status = 'PENDING' AND next_retry_at <= ? "
                        + "ORDER BY next_retry_at ASC LIMIT " + LIST_LIMIT,
                HisCancelTaskRepository::mapRow, Timestamp.from(now));
    }

    public int markDone(String appointmentId) {
        return jdbc.update("UPDATE his_cancel_tasks SET status = 'DONE', last_error = NULL, updated_at = ? "
                + "WHERE appointment_id = ? AND status = 'PENDING'",
                Timestamp.from(Instant.now()), appointmentId);
    }

    /** 失败退避；attempts 达上限时由调用方置 DEAD（保留记录等人工处理，不静默删除）。 */
    public int markFailure(String appointmentId, String error, boolean dead, Instant nextRetryAt) {
        return jdbc.update("UPDATE his_cancel_tasks SET attempts = attempts + 1, last_error = ?, "
                        + "status = ?, next_retry_at = ?, updated_at = ? "
                        + "WHERE appointment_id = ? AND status = 'PENDING'",
                truncate(error), dead ? "DEAD" : "PENDING", Timestamp.from(nextRetryAt),
                Timestamp.from(Instant.now()), appointmentId);
    }

    private static Task mapRow(ResultSet rs, int rowNum) throws SQLException {
        return new Task(
                rs.getLong("id"),
                rs.getString("appointment_id"),
                rs.getString("his_order_no"),
                rs.getString("reason"),
                rs.getInt("attempts"));
    }

    private static String safeReason(String reason) {
        if (reason == null) {
            return null;
        }
        return reason.length() <= 255 ? reason : reason.substring(0, 255);
    }

    private static String truncate(String error) {
        if (error == null) {
            return null;
        }
        return error.length() <= 255 ? error : error.substring(0, 255);
    }
}
