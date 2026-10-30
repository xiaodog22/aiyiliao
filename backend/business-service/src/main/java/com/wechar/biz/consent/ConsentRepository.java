package com.wechar.biz.consent;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * consents 表数据访问（V1 已有表 + V5 追加幂等列）。
 * 语义（契约 listConsents / grantConsent）：只追加不覆盖；**当前状态 = 该 (user_id, purpose) 最新一行**，
 * 撤回记录同样返回、不原地覆盖，因此撤回也以"追加一行 status=WITHDRAWN"表达。
 */
@Component
public class ConsentRepository {

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper = new ObjectMapper();

    public ConsentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static final String RECORD_SELECT =
            "SELECT c.purpose, c.policy_version, c.scope_json, c.status, c.channel, "
                    + "c.created_at, c.withdrawn_at FROM consents c ";

    private static final String LATEST_BY_PURPOSE =
            " AND c.created_at = (SELECT MAX(c2.created_at) FROM consents c2 "
                    + "WHERE c2.user_id = c.user_id AND c2.purpose = c.purpose) ";

    /**
     * 契约 ConsentRecord 列表（/me 的 User.consents 与 /consents 共用同一查询，
     * 避免两处口径漂移）：每 purpose 取最新一行。
     */
    public List<Map<String, Object>> listFor(String userId) {
        return jdbc.query(RECORD_SELECT + "WHERE c.user_id = ? " + LATEST_BY_PURPOSE + "ORDER BY c.purpose",
                ConsentRepository::mapRecord, userId);
    }

    /** 该 purpose 的最新记录（撤回响应用）；从未授权/撤回后再次撤回都以最新一行判定。 */
    public Optional<Map<String, Object>> findLatest(String userId, String purpose) {
        return jdbc.query(RECORD_SELECT + "WHERE c.user_id = ? AND c.purpose = ? " + LATEST_BY_PURPOSE,
                ConsentRepository::mapRecord, userId, purpose).stream().findFirst();
    }

    /** 幂等：该键已用于的载荷摘要（同键同摘要 → 重放；同键异摘要 → 409）。 */
    public Optional<String> findDigestByIdempotencyKey(String userId, String idempotencyKey) {
        return jdbc.query("SELECT request_digest FROM consents WHERE user_id = ? AND idempotency_key = ?",
                (rs, i) -> rs.getString("request_digest"), userId, idempotencyKey).stream().findFirst();
    }

    /** 追加一行同意记录（grant 与 withdraw 共用；状态由调用方给定，reason 仅撤回时有值）。 */
    public void append(String id, String userId, String purpose, String policyVersion, String status,
                       String channel, String scopeJson, String evidenceDigest, Instant withdrawnAt,
                       String withdrawReason, String idempotencyKey, String requestDigest, Instant now) {
        jdbc.update("INSERT INTO consents (id, user_id, purpose, policy_version, status, channel, scope_json, "
                        + "evidence_digest, withdrawn_at, withdraw_reason, idempotency_key, request_digest, created_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                id, userId, purpose, policyVersion, status, channel, scopeJson, evidenceDigest,
                withdrawnAt == null ? null : Timestamp.from(withdrawnAt), withdrawReason,
                idempotencyKey, requestDigest, Timestamp.from(now));
    }

    /** 行 → 契约 ConsentRecord 字段（时间统一 ISO-8601 UTC 字符串，与 /me 历史输出一致）。 */
    private static Map<String, Object> mapRecord(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("purpose", rs.getString("purpose"));
        m.put("policyVersion", rs.getString("policy_version"));
        String scopeJson = rs.getString("scope_json");
        m.put("scope", scopeJson == null ? List.of() : parseScope(scopeJson));
        m.put("status", rs.getString("status"));
        m.put("channel", rs.getString("channel"));
        Timestamp created = rs.getTimestamp("created_at");
        m.put("updatedAt", created == null ? null : created.toInstant().toString());
        Timestamp withdrawn = rs.getTimestamp("withdrawn_at");
        m.put("withdrawnAt", withdrawn == null ? null : withdrawn.toInstant().toString());
        return m;
    }

    /** scope_json → 字符串数组（解析失败返回空数组，不猜内容）。 */
    private static List<String> parseScope(String scopeJson) {
        try {
            var node = new ObjectMapper().readTree(scopeJson);
            List<String> out = new ArrayList<>();
            if (node != null && node.isArray()) {
                node.forEach(n -> out.add(n.asText()));
            }
            return out;
        } catch (Exception e) {
            return List.of();
        }
    }

    /** scope 列表 → scope_json（空列表写 NULL，不在库里留 "[]"）。 */
    public String scopeJson(List<String> scope) {
        if (scope == null || scope.isEmpty()) {
            return null;
        }
        try {
            return objectMapper.writeValueAsString(scope);
        } catch (Exception e) {
            return null;
        }
    }
}
