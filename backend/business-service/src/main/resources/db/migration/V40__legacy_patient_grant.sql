-- =====================================================================
-- V40__legacy_patient_grant.sql —— 历史预约降级读白名单 + 健康记录归属标记（2026-11-27）
--
-- 背景（D4 定稿）：D4 起新预约强制 patient_ref；历史预约没有，直接 403 会触发业务
-- 要求回滚。改用「限期降级读」：白名单放行 + 响应降级标记 + 固定窗口到期收口。
--
-- 口径（owner 2026-11-27 裁决）：
--   · 90 天固定窗口，从**首次授权日**起算，不按最后访问日滚动续期；
--   · 审批按**角色**（HIS_ADMIN / MEDICAL_RECORDS），至少两人可批；
--   · 审批人不得是该白名单的 user_id 本人（DB CHECK 强制）；
--   · 只允许管理员手工续期一次，写 renewed_at / renew_count，不做自动续期。
-- =====================================================================

CREATE TABLE IF NOT EXISTS legacy_patient_read_grant (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    user_id       VARCHAR(64)  NOT NULL COMMENT '被授权读取的平台用户 users.id',
    his_patient_id VARCHAR(64) NOT NULL COMMENT '授权的目标 HIS 档案 patients.id',
    patient_ref   VARCHAR(64)  NULL     COMMENT '迁移后回填的 patient_index.patient_ref；NULL=尚未建主索引',
    expires_at    DATETIME(3)  NOT NULL COMMENT '固定窗口到期时间（首次授权 + 90 天）',
    approved_by   VARCHAR(64)  NOT NULL COMMENT '审批人 userId（审计只记 id，不记姓名）',
    approved_role VARCHAR(32)  NOT NULL COMMENT 'HIS_ADMIN / MEDICAL_RECORDS',
    reason        VARCHAR(200) NOT NULL COMMENT '审批理由（必填）',
    renewed_at    DATETIME(3)  NULL     COMMENT '人工续期时间；仅允许一次',
    renew_count   TINYINT      NOT NULL DEFAULT 0,
    revoked_at    DATETIME(3)  NULL     COMMENT '提前撤销时间',
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at    DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_lpg_user_his (user_id, his_patient_id),
    KEY idx_lpg_expire (expires_at),
    KEY idx_lpg_patient_ref (patient_ref),
    CONSTRAINT ck_lpg_no_self CHECK (approved_by <> user_id),
    CONSTRAINT ck_lpg_renew_once CHECK (renew_count BETWEEN 0 AND 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='历史预约读取白名单（限期降级读，到期 409 收口）';

-- 平台侧角色授予：Q2 要求「按角色批、至少两人」，而不是固定某个账号。
-- 当前平台没有角色体系，这里只建最小存储；授予是运维动作（不提供自助入口）。
CREATE TABLE IF NOT EXISTS platform_role_grant (
    id         BIGINT      NOT NULL AUTO_INCREMENT,
    user_id    VARCHAR(64) NOT NULL COMMENT '平台用户 users.id',
    role_code  VARCHAR(32) NOT NULL COMMENT 'HIS_ADMIN / MEDICAL_RECORDS',
    granted_by VARCHAR(64) NOT NULL COMMENT '授予人（运维/管理员 userId）',
    reason     VARCHAR(200) NULL,
    revoked_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_prg_user_role (user_id, role_code),
    KEY idx_prg_role (role_code, revoked_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台侧角色授予（白名单审批资格的最小实现）';

-- 健康记录补患者维度：只加列，不改历史行、不删除。
-- legacy_attribution：NULL=正常归属；REVERSED=经 visits 反查补全；UNKNOWN=无法归属（读取 409，不降级）。
ALTER TABLE health_records
    ADD COLUMN patient_ref VARCHAR(64) NULL COMMENT '归属就诊人；NULL=历史未归属' AFTER family_member_id,
    ADD COLUMN legacy_attribution VARCHAR(16) NULL COMMENT 'UNKNOWN / REVERSED；NULL=正常' AFTER patient_ref,
    ADD KEY idx_health_records_patient (patient_ref),
    ADD KEY idx_health_records_legacy (legacy_attribution);

-- 回滚（只允许后续修复迁移）：
--   ALTER TABLE health_records DROP KEY idx_health_records_legacy, DROP KEY idx_health_records_patient,
--     DROP COLUMN legacy_attribution, DROP COLUMN patient_ref;
--   DROP TABLE platform_role_grant;
--   DROP TABLE legacy_patient_read_grant;
-- =====================================================================
