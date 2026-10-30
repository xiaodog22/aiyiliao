-- =====================================================================
-- V2__m1_tables.sql —— M1 新增表（用户偏好 + 内容目录）
-- 事实源：backend/contracts/business-openapi.yaml
-- 约定：utf8mb4；时间 UTC（DATETIME(3)）；主键应用生成（VARCHAR(64)）。
-- 说明：
--   - V1 已覆盖 users/user_profiles/consents/departments/doctors/doctor_slots/appointments，本文件不重复建。
--   - 预约幂等/乐观锁复用 V1 appointments 表的 idempotency_key 唯一键与 version 列。
-- =====================================================================

-- 用户偏好：GET /me 返回的 User（契约 additionalProperties:false）不含偏好，
-- 偏好通过 PUT /api/v1/me/preferences 读写，本表即其权威存储。
CREATE TABLE user_preferences (
    user_id       VARCHAR(64)  NOT NULL,
    locale        VARCHAR(20)  NOT NULL DEFAULT 'zh-CN',
    theme_mode    VARCHAR(16)  NOT NULL DEFAULT 'SYSTEM',
    font_scale    VARCHAR(16)  NOT NULL DEFAULT 'STANDARD',
    tts_rate      DECIMAL(3,2) NULL,
    tts_auto_play TINYINT(1)   NOT NULL DEFAULT 0,
    version       INT          NOT NULL DEFAULT 1,
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (user_id),
    CONSTRAINT fk_user_preferences_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- 健康科普内容目录：只读。可见性 = review_status='APPROVED' 且在 effective_from/effective_to 有效期内。
-- provenance 固定 HUMAN_REVIEWED（契约 ProvenanceType：规则结果/AI 生成/人工审核必须如实标注）。
CREATE TABLE contents (
    id             VARCHAR(64)   NOT NULL,
    title          VARCHAR(120)  NOT NULL,
    summary        VARCHAR(200)  NULL,
    category       VARCHAR(40)   NOT NULL,
    body           TEXT          NOT NULL,
    source         VARCHAR(200)  NULL,
    reviewer       VARCHAR(40)   NULL,
    cover_key      VARCHAR(128)  NULL,
    review_status  VARCHAR(20)   NOT NULL DEFAULT 'DRAFT',
    provenance     VARCHAR(20)   NOT NULL DEFAULT 'HUMAN_REVIEWED',
    effective_from DATE          NULL,
    effective_to   DATE          NULL,
    published_at   DATETIME(3)   NULL,
    read_count     INT           NOT NULL DEFAULT 0,
    created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at     DATETIME(3)   NULL DEFAULT NULL,
    PRIMARY KEY (id),
    KEY idx_contents_status_category (review_status, category),
    KEY idx_contents_published (published_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
