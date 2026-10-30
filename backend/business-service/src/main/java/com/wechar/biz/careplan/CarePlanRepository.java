package com.wechar.biz.careplan;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * care_plan_requests 数据访问（M2.4）。
 * 幂等：(user_id, idempotency_key) 唯一 + request_digest 同键同体比对；
 * 结果落库（result_json / refused / refusal_reason）供同键重放，不重复消耗算力。
 */
@Component
public class CarePlanRepository {

    private final JdbcTemplate jdbc;

    public CarePlanRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 状态：PENDING（生成中）/ COMPLETED（已给出建议）/ REFUSED（结构化拒答）。 */
    public record CarePlanRow(String id, String userId, String goal, String constraintsJson, String locale,
                              String status, String taskId, String resultJson, boolean refused,
                              String refusalReason, String idempotencyKey, String requestDigest,
                              Instant createdAt, Instant updatedAt) {
    }

    private static final String COLS = "id, user_id, goal, constraints_json, locale, status, task_id, "
            + "result_json, refused, refusal_reason, idempotency_key, request_digest, created_at, updated_at";

    private static CarePlanRow map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp updated = rs.getTimestamp("updated_at");
        return new CarePlanRow(rs.getString("id"), rs.getString("user_id"), rs.getString("goal"),
                rs.getString("constraints_json"), rs.getString("locale"), rs.getString("status"),
                rs.getString("task_id"), rs.getString("result_json"),
                rs.getInt("refused") == 1, rs.getString("refusal_reason"),
                rs.getString("idempotency_key"), rs.getString("request_digest"),
                created == null ? null : created.toInstant(),
                updated == null ? null : updated.toInstant());
    }

    public void insert(CarePlanRow row) {
        jdbc.update("INSERT INTO care_plan_requests (" + COLS + ") "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.userId(), row.goal(), row.constraintsJson(), row.locale(), row.status(),
                row.taskId(), row.resultJson(), row.refused() ? 1 : 0, row.refusalReason(),
                row.idempotencyKey(), row.requestDigest(), Timestamp.from(row.createdAt()), null);
    }

    /** 同键请求（幂等重放/异体 409 比对依据）。 */
    public Optional<CarePlanRow> findByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + COLS + " FROM care_plan_requests WHERE user_id = ? AND idempotency_key = ?",
                CarePlanRepository::map, userId, key).stream().findFirst();
    }

    /** 生成完成落库（PENDING → COMPLETED/REFUSED；结果与拒答一并持久化供重放）。 */
    public void complete(String id, String taskId, String resultJson, boolean refused, String refusalReason,
                         String status, Instant now) {
        jdbc.update("UPDATE care_plan_requests SET task_id = ?, result_json = ?, refused = ?, "
                        + "refusal_reason = ?, status = ?, updated_at = ? WHERE id = ?",
                taskId, resultJson, refused ? 1 : 0, refusalReason, status, Timestamp.from(now), id);
    }
}
