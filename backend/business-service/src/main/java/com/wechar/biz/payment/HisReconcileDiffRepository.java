package com.wechar.biz.payment;

import java.sql.Timestamp;
import java.time.Instant;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * HIS 对账差异台账（L5，2026-11-22）。
 *
 * <p>为什么需要落库：原实现只在日志里 mismatches++，日志滚掉后差异不可追踪；
 * 台账提供 OPEN/RESOLVED 生命周期，重复对账幂等 upsert，恢复一致时自动 RESOLVED。
 * 只记录业务标识与状态，不写患者信息。
 */
@Repository
public class HisReconcileDiffRepository {

    private final JdbcTemplate jdbc;

    public HisReconcileDiffRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 记录/刷新 OPEN 差异；同一 bizType+bizId 只保留一条（重复对账不膨胀）。 */
    public void recordOpen(String bizType, String bizId, String expected, String actual, String detail) {
        Instant now = Instant.now();
        int updated = updateOpen(bizType, bizId, expected, actual, detail, now);
        if (updated > 0) {
            return;
        }
        try {
            jdbc.update("INSERT INTO his_reconcile_diffs (biz_type, biz_id, expected_status, actual_status, "
                            + "detail, status, first_seen_at, last_seen_at) "
                            + "VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)",
                    bizType, bizId, expected, actual, truncate(detail),
                    Timestamp.from(now), Timestamp.from(now));
        } catch (DuplicateKeyException raced) {
            // 并发对账同时插入：转为更新，保持幂等
            updateOpen(bizType, bizId, expected, actual, detail, now);
        }
    }

    /** 对账恢复一致 → 关闭 OPEN 差异（没有则无操作）。 */
    public int resolve(String bizType, String bizId) {
        return jdbc.update("UPDATE his_reconcile_diffs SET status = 'RESOLVED', resolved_at = ? "
                        + "WHERE biz_type = ? AND biz_id = ? AND status = 'OPEN'",
                Timestamp.from(Instant.now()), bizType, bizId);
    }

    /**
     * 仍处于 OPEN 的业务 ID（L5 扩展）：用于把「退费待同步」「超出时间窗口」的订单
     * 拉回对账视野，避免台账开了却永远没人再看。
     */
    public java.util.List<String> listOpenBizIds(String bizType) {
        return jdbc.queryForList(
                "SELECT biz_id FROM his_reconcile_diffs WHERE biz_type = ? AND status = 'OPEN'",
                String.class, bizType);
    }

    private int updateOpen(String bizType, String bizId, String expected, String actual,
                           String detail, Instant now) {
        return jdbc.update("UPDATE his_reconcile_diffs SET expected_status = ?, actual_status = ?, "
                        + "detail = ?, last_seen_at = ?, status = 'OPEN', resolved_at = NULL "
                        + "WHERE biz_type = ? AND biz_id = ?",
                expected, actual, truncate(detail), Timestamp.from(now), bizType, bizId);
    }

    private static String truncate(String detail) {
        if (detail == null) {
            return null;
        }
        return detail.length() <= 255 ? detail : detail.substring(0, 255);
    }
}
