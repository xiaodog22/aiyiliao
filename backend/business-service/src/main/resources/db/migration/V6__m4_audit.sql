-- =====================================================================
-- V6__m4_audit.sql —— M4 审计事件表（audit_events）
-- 事实源：docs/v4/03 §39「audit_events：不可含原始健康内容；保存谁在何时对哪类对象执行何动作」
--         + docs/v4/03 §147「审计日志防篡改并设访问权限」+ 08B §M4「审计」
-- 约定：utf8mb4；时间 UTC（DATETIME(3)）；主键应用生成（VARCHAR(64)）。
-- 防篡改口径：应用层只追加（AuditLog 仅提供 insert，无 update/delete）；
--             写入内容来自请求元数据（方法/路径模式/状态码），**不落请求体**，
--             故天然不含症状描述、手机号、健康明细等原始内容。
-- =====================================================================
CREATE TABLE audit_events (
    id            VARCHAR(64)  NOT NULL,
    actor_user_id VARCHAR(64)  NULL,          -- 未认证时为 NULL（如匿名撞受保护路径）
    action        VARCHAR(160) NOT NULL,      -- 例：POST /api/v1/consents/{purpose}/withdraw
    object_type   VARCHAR(48)  NOT NULL,      -- 对象类目（路径域），例：appointment / consent
    outcome       VARCHAR(16)  NOT NULL,      -- SUCCESS / DENIED / FAILED
    status_code   INT          NOT NULL,      -- HTTP 状态码（结果证据）
    request_id    VARCHAR(64)  NULL,          -- 与响应 requestId 串联（docs/v4/03 §152）
    client_ip     VARCHAR(64)  NULL,          -- 可脱敏存储（调用方可见 IP；本机部署为环回）
    server_time   DATETIME(3)  NOT NULL,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_audit_actor_time (actor_user_id, server_time),
    KEY idx_audit_object_time (object_type, server_time),
    KEY idx_audit_action_time (action, server_time),
    KEY idx_audit_request (request_id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
