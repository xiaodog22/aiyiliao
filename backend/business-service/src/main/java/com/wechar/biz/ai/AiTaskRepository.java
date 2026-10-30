package com.wechar.biz.ai;

import com.wechar.biz.ai.AiTaskService.AiTaskRow;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * ai_tasks 数据访问（M2）。任务行是业务侧权威记录；上游任务 ID 用于编排同步。
 * 状态更新一律带 WHERE status NOT IN (终态) 守卫：并发同步不会把终态改回非终态。
 */
@Component
public class AiTaskRepository {

    private final JdbcTemplate jdbc;

    public AiTaskRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String COLS = "id, user_id, consultation_id, task_type, status, progress_phase, "
            + "model_profile, model_id, model_version, policy_version, input_ref, upstream_task_id, "
            + "result_json, error_code, error_message, error_retryable, created_at, updated_at, expires_at";

    private static AiTaskRow map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        Timestamp expires = rs.getTimestamp("expires_at");
        return new AiTaskRow(
                rs.getString("id"), rs.getString("user_id"), rs.getString("consultation_id"),
                rs.getString("task_type"), rs.getString("status"), rs.getString("progress_phase"),
                rs.getString("model_profile"), rs.getString("model_id"), rs.getString("model_version"),
                rs.getString("policy_version"), rs.getString("input_ref"),
                rs.getString("upstream_task_id"), rs.getString("result_json"), rs.getString("error_code"),
                rs.getString("error_message"), readNullableBoolean(rs, "error_retryable"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant(),
                expires == null ? null : expires.toInstant());
    }

    /**
     * 可空布尔列读取：MySQL 的 TINYINT(1) 与 H2 的整型在 getObject 下分别返回
     * Boolean/Integer（实现差异），硬转 Boolean 会在 H2 测试环境抛 ClassCastException
     * （500）。统一按"非零即真"归一化，NULL 保持 null。
     */
    private static Boolean readNullableBoolean(java.sql.ResultSet rs, String column)
            throws java.sql.SQLException {
        Object value = rs.getObject(column);
        if (value == null) {
            return null;
        }
        if (value instanceof Boolean bool) {
            return bool;
        }
        return ((Number) value).intValue() != 0;
    }

    public Optional<AiTaskRow> findById(String id) {
        return jdbc.query("SELECT " + COLS + " FROM ai_tasks WHERE id = ?", AiTaskRepository::map, id)
                .stream().findFirst();
    }

    public void insert(AiTaskRow row) {
        jdbc.update("INSERT INTO ai_tasks (" + COLS + ") "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.userId(), row.consultationId(), row.taskType(), row.status(), row.progressPhase(),
                row.modelProfile(), row.modelId(), row.modelVersion(), row.policyVersion(), row.inputRef(),
                row.upstreamTaskId(), row.resultJson(),
                row.errorCode(), row.errorMessage(), row.errorRetryable(), Timestamp.from(row.createdAt()),
                null, row.expiresAt() == null ? null : Timestamp.from(row.expiresAt()));
    }

    /** 把上游任务快照落回本地行（带终态守卫：终态不可回退）。modelId/Version 仅在上游给出时更新。 */
    public void applyUpstream(String id, String status, String progressPhase, String resultJson,
                              String errorCode, String errorMessage, Boolean retryable,
                              String modelId, String modelVersion,
                              Instant now, Instant expiresAt) {
        jdbc.update("UPDATE ai_tasks SET status = ?, progress_phase = ?, result_json = ?, error_code = ?, "
                        + "error_message = ?, error_retryable = ?, "
                        + "model_id = COALESCE(?, model_id), model_version = COALESCE(?, model_version), "
                        + "updated_at = ?, "
                        + "expires_at = COALESCE(?, expires_at) "
                        + "WHERE id = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED')",
                status, progressPhase, resultJson, errorCode, errorMessage, retryable,
                modelId, modelVersion,
                Timestamp.from(now), expiresAt == null ? null : Timestamp.from(expiresAt), id);
    }

    /** 超预算：非终态 → EXPIRED（超时而非失败/空态）。 */
    public void expire(String id, Instant now) {
        jdbc.update("UPDATE ai_tasks SET status = 'EXPIRED', updated_at = ? "
                        + "WHERE id = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED')",
                Timestamp.from(now), id);
    }

    /** 本地强制取消（上游不可达但用户已撤回：不假装任务还在跑）。 */
    public void forceCancel(String id, Instant now) {
        jdbc.update("UPDATE ai_tasks SET status = 'CANCELLED', updated_at = ? "
                        + "WHERE id = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED')",
                Timestamp.from(now), id);
    }

    /** 上游任务丢失：FAILED + 稳定码（可重试，用户可重发消息）。 */
    public void markFailed(String id, String code, String message, boolean retryable, Instant now) {
        jdbc.update("UPDATE ai_tasks SET status = 'FAILED', error_code = ?, error_message = ?, "
                        + "error_retryable = ?, updated_at = ? "
                        + "WHERE id = ? AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED')",
                code, message, retryable, Timestamp.from(now), id);
    }

    /** 会话下最近一次非终态任务（confirmations 终止源任务生成用）。 */
    public Optional<AiTaskRow> findLatestActiveForConsultation(String consultationId) {
        return jdbc.query("SELECT " + COLS + " FROM ai_tasks WHERE consultation_id = ? "
                        + "AND status NOT IN ('SUCCEEDED','FAILED','CANCELLED','EXPIRED') "
                        + "ORDER BY created_at DESC LIMIT 1",
                AiTaskRepository::map, consultationId).stream().findFirst();
    }

    /** 会话下最近任务（详情页展示最新生成状态）。 */
    public Optional<AiTaskRow> findLatestForConsultation(String consultationId) {
        return jdbc.query("SELECT " + COLS + " FROM ai_tasks WHERE consultation_id = ? "
                        + "ORDER BY created_at DESC LIMIT 1", AiTaskRepository::map, consultationId)
                .stream().findFirst();
    }

    /**
     * 会话下最近一次指定类型的任务（2026-10-24：AI 分诊 TRIAGE 任务查询）。
     * 用于「同会话 60s 内已有分诊任务就复用」的防抖，避免单并发模型被连点打爆。
     */
    public Optional<AiTaskRow> findLatestByType(String consultationId, String taskType) {
        return jdbc.query("SELECT " + COLS + " FROM ai_tasks WHERE consultation_id = ? AND task_type = ? "
                        + "ORDER BY created_at DESC LIMIT 1",
                AiTaskRepository::map, consultationId, taskType).stream().findFirst();
    }
}
