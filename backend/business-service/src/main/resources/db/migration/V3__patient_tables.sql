-- =====================================================================
-- V3__patient_tables.sql —— M1 补齐：会话 + 患者域（健康档案/家庭成员/邀请）
-- 事实源：backend/contracts/business-openapi.yaml（Session 刷新轮换、health-records、family-members）
-- 约定：utf8mb4；时间 UTC（DATETIME(3)）；主键应用生成（VARCHAR(64)）。
-- 说明：V1/V2 已应用不可改；本文件只建新表。
-- =====================================================================

-- 认证会话（契约 Session：refreshToken 一次一换；服务端只保存哈希）。
-- access 明文只出现在响应体；refresh 已使用（refresh_used=1）后再来视为重放 → 401。
CREATE TABLE auth_sessions (
    id                 VARCHAR(64)  NOT NULL,
    user_id            VARCHAR(64)  NOT NULL,
    access_token_hash  CHAR(64)     NOT NULL,
    refresh_token_hash CHAR(64)     NOT NULL,
    access_expires_at  DATETIME(3)  NOT NULL,
    refresh_expires_at DATETIME(3)  NOT NULL,
    revoked            TINYINT(1)   NOT NULL DEFAULT 0,
    refresh_used       TINYINT(1)   NOT NULL DEFAULT 0,
    created_at         DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    revoked_at         DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_auth_sessions_access (access_token_hash),
    UNIQUE KEY uq_auth_sessions_refresh (refresh_token_hash),
    KEY idx_auth_sessions_user (user_id),
    CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 健康档案（契约 HealthRecord：id/category/recordedAt 必填，category 枚举 6 值）。
-- 幂等：POST 要求 Idempotency-Key，(user_id, idempotency_key) 唯一。
CREATE TABLE health_records (
    id               VARCHAR(64)  NOT NULL,
    user_id          VARCHAR(64)  NOT NULL,
    family_member_id VARCHAR(64)  NULL,
    category         VARCHAR(20)  NOT NULL,
    title            VARCHAR(80)  NULL,
    summary          VARCHAR(500) NULL,
    recorded_at      DATETIME(3)  NOT NULL,
    version          INT          NOT NULL DEFAULT 1,
    idempotency_key  VARCHAR(128) NULL,
    request_digest   CHAR(64)     NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at       DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_health_records_idem (user_id, idempotency_key),
    KEY idx_health_records_user (user_id),
    CONSTRAINT fk_health_records_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 家庭成员（契约 FamilyMember：proxyStatus 添加时恒为 NONE —— 添加 ≠ 获得代理权限）。
CREATE TABLE family_members (
    id               VARCHAR(64)  NOT NULL,
    user_id          VARCHAR(64)  NOT NULL,
    display_name     VARCHAR(40)  NOT NULL,
    relation         VARCHAR(20)  NOT NULL,
    proxy_status     VARCHAR(16)  NOT NULL DEFAULT 'NONE',
    age_band         VARCHAR(20)  NULL,
    avatar_url       VARCHAR(255) NULL,
    phone_hash       CHAR(64)     NULL,
    idempotency_key  VARCHAR(128) NULL,
    request_digest   CHAR(64)     NULL,
    created_at       DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at       DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_family_members_idem (user_id, idempotency_key),
    KEY idx_family_members_user (user_id),
    CONSTRAINT fk_family_members_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 家庭绑定邀请（契约：令牌一次性、仅创建响应返回；服务端只保存哈希，不存明文）。
CREATE TABLE family_invitations (
    invitation_id VARCHAR(64)  NOT NULL,
    user_id       VARCHAR(64)  NOT NULL,
    relation      VARCHAR(20)  NOT NULL,
    channel       VARCHAR(20)  NULL,
    token_hash    CHAR(64)     NOT NULL,
    phone_hash    CHAR(64)     NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    expires_at    DATETIME(3)  NOT NULL,
    used_at       DATETIME(3)  NULL DEFAULT NULL,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (invitation_id),
    UNIQUE KEY uq_family_invitations_token (token_hash),
    KEY idx_family_invitations_user (user_id),
    CONSTRAINT fk_family_invitations_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
