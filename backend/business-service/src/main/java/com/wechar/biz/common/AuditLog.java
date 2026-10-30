package com.wechar.biz.common;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * M4 审计写入（08B §M4「审计」+ docs/v4/03 §39/§147）。
 *
 * 硬约束（docs/v4/03 §39）：audit_events **不可含原始健康内容**——
 * 本组件只接收请求元数据（方法、路径模式、状态码、主体、requestId），
 * 不接收请求体/响应体，故症状描述、手机号、健康明细不会进入审计。
 *
 * 防篡改口径：应用层只追加（本类仅提供 record()，无任何 update/delete）；
 * 写入失败不打断业务响应（记 ERROR 日志 + requestId 供追查），
 * 不做"静默吞错"——失败必然在应用日志可见。
 *
 * 记录范围（app.audit.enabled=true 时）：
 *  - 全部非 2xx（DENIED/FAILED：鉴权拒绝、校验失败、冲突等安全证据）；
 *  - 全部写操作（POST/PUT/PATCH/DELETE，无论成败：谁在何时对哪类对象执行何动作）。
 * 只读 2xx 不记录，避免低配环境刷表。
 */
@Component
public class AuditLog {

    private static final Logger log = LoggerFactory.getLogger(AuditLog.class);

    private final JdbcTemplate jdbc;
    private final Clock clock;
    private final boolean enabled;

    public AuditLog(JdbcTemplate jdbc, Clock clock,
                    @Value("${app.audit.enabled:true}") boolean enabled) {
        this.jdbc = jdbc;
        this.clock = clock;
        this.enabled = enabled;
    }

    /** 是否启用审计（拦截器据此短路）。 */
    public boolean enabled() {
        return enabled;
    }

    /**
     * 记录一条审计事件（只追加）。
     *
     * @param actorUserId 认证主体；未认证为 null
     * @param action      例：POST /api/v1/consents/{purpose}/withdraw（路径模板，非具体 ID）
     * @param objectType  对象类目（/api/v1/ 后的首段），例：appointment
     * @param statusCode  最终 HTTP 状态码
     * @param requestId   与响应串联
     * @param clientIp    调用方 IP（可为 null）
     */
    public void record(String actorUserId, String action, String objectType,
                       int statusCode, String requestId, String clientIp) {
        if (!enabled) {
            return;
        }
        String outcome = outcomeOf(statusCode);
        Instant now = clock.instant();
        try {
            jdbc.update("INSERT INTO audit_events (id, actor_user_id, action, object_type, outcome, "
                            + "status_code, request_id, client_ip, server_time) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    "ae-" + UUID.randomUUID(), normalizeActor(actorUserId), action, objectType, outcome,
                    statusCode, requestId, clientIp, Timestamp.from(now));
        } catch (RuntimeException e) {
            // 审计失败不打断业务；但必须在应用日志留痕（不静默）
            log.error("审计写入失败 action={} requestId={}", action, requestId, e);
        }
    }

    /**
     * actor 规范化：拦截器拿到的是身份源值（dev 档为 openid 形态 dev-user-1），
     * 业务表主键是 u-dev-user-1 —— 审计必须与业务主键同一命名空间，
     * 否则按 user 关联审计与业务数据时对不上。查不到映射时保留原值（不丢主体）。
     */
    private String normalizeActor(String actorUserId) {
        if (actorUserId == null || actorUserId.isBlank() || actorUserId.startsWith("u-")) {
            return actorUserId;
        }
        try {
            String mapped = jdbc.query("SELECT id FROM users WHERE wechat_openid = ? OR id = ?",
                    (rs, i) -> rs.getString(1), actorUserId, actorUserId).stream().findFirst().orElse(null);
            return mapped != null ? mapped : actorUserId;
        } catch (RuntimeException e) {
            log.warn("审计主体规范化失败 actor={}（保留原值）", actorUserId, e);
            return actorUserId;
        }
    }

    /** 状态码 → outcome：401/403 = DENIED（鉴权/授权拒绝），其他非 2xx = FAILED，2xx = SUCCESS。 */
    static String outcomeOf(int statusCode) {
        if (statusCode >= 200 && statusCode < 300) {
            return "SUCCESS";
        }
        if (statusCode == 401 || statusCode == 403) {
            return "DENIED";
        }
        return "FAILED";
    }
}
