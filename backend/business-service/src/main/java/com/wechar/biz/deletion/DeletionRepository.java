package com.wechar.biz.deletion;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.deletion.dto.RetainedItemData;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * deletion_requests 表数据访问（V5 新建表）。
 * 查询一律带 user_id 条件（契约 getDeletionRequest："他人的申请一律返回 404，不返回 403"）。
 */
@Component
public class DeletionRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public DeletionRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record DeletionRow(String id, String userId, String scopeJson, String status, String reason,
                              String retainedJson, String idempotencyKey, String requestDigest,
                              Instant createdAt, Instant completedAt) {
    }

    private static final String COLS = "id, user_id, scope_json, status, reason, retained_items_json, "
            + "idempotency_key, request_digest, created_at, completed_at";

    private static DeletionRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        Timestamp completed = rs.getTimestamp("completed_at");
        return new DeletionRow(rs.getString("id"), rs.getString("user_id"), rs.getString("scope_json"),
                rs.getString("status"), rs.getString("reason"), rs.getString("retained_items_json"),
                rs.getString("idempotency_key"), rs.getString("request_digest"),
                created == null ? null : created.toInstant(),
                completed == null ? null : completed.toInstant());
    }

    public Optional<DeletionRow> findByIdForUser(String requestId, String userId) {
        return jdbc.query("SELECT " + COLS + " FROM deletion_requests WHERE id = ? AND user_id = ?",
                DeletionRepository::map, requestId, userId).stream().findFirst();
    }

    public Optional<DeletionRow> findByIdempotencyKey(String userId, String key) {
        return jdbc.query("SELECT " + COLS + " FROM deletion_requests WHERE user_id = ? AND idempotency_key = ?",
                DeletionRepository::map, userId, key).stream().findFirst();
    }

    public void insert(DeletionRow row) {
        jdbc.update("INSERT INTO deletion_requests (id, user_id, scope_json, status, reason, retained_items_json, "
                        + "idempotency_key, request_digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.userId(), row.scopeJson(), row.status(), row.reason(), row.retainedJson(),
                row.idempotencyKey(), row.requestDigest(), Timestamp.from(row.createdAt()));
    }

    /** scope / retainedItems 的 JSON 序列化（失败 → 抛异常，不静默写空）。 */
    public String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("注销申请归档序列化失败", e);
        }
    }

    /** JSON 数组 → 字符串列表（解析失败返回空列表，不猜内容）。 */
    public static List<String> parseStringList(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            var node = new ObjectMapper().readTree(json);
            List<String> out = new java.util.ArrayList<>();
            if (node != null && node.isArray()) {
                node.forEach(n -> out.add(n.asText()));
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** JSON 数组 → retainedItems（契约：每项 category/reason 必填，retainUntil 可空）。 */
    public static List<RetainedItemData> parseRetainedItems(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            var node = new ObjectMapper().readTree(json);
            List<RetainedItemData> out = new java.util.ArrayList<>();
            if (node != null && node.isArray()) {
                for (var item : node) {
                    out.add(new RetainedItemData(item.path("category").asText(null),
                            item.path("reason").asText(null), item.path("retainUntil").asText(null)));
                }
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** 幂等摘要比对（同键同载荷 → 重放；同键异载荷 → 409）。 */
    public static boolean sameDigest(DeletionRow row, String digest) {
        return Objects.equals(row.requestDigest(), digest);
    }
}
