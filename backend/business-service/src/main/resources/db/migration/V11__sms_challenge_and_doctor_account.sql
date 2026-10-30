-- =====================================================================
-- V11__sms_challenge_and_doctor_account.sql —— N9 短信验证码 + N8 医生账号登录（2026-10-19）
-- 事实源：docs/接口需求_待后端实现_20261019.md §三轮 N8/N9 + backend/contracts/business-openapi.yaml
-- 约定：验证码只存 SHA-256 哈希（不存明文/不入日志）；challenge_id 一次性（UNIQUE）；
--      时间 UTC（DATETIME(3)）。
-- =====================================================================

-- 短信验证码挑战：phone_hash = sha256(手机号)，code_hash = sha256(6 位验证码)
CREATE TABLE sms_challenges (
    id           VARCHAR(64)  NOT NULL,
    phone_hash   CHAR(64)     NOT NULL,
    scene        VARCHAR(32)  NOT NULL,
    code_hash    CHAR(64)     NOT NULL,
    challenge_id VARCHAR(64)  NOT NULL,
    expires_at   DATETIME(3)  NOT NULL,
    consumed_at  DATETIME(3)  NULL,
    attempts     INT          NOT NULL DEFAULT 0,
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uk_sms_challenges_challenge (challenge_id),
    KEY idx_sms_challenges_phone_created (phone_hash, created_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- N8 决策（登记于任务回执）：doctors 表无工号列，而 design 03-医生登录为「工号或手机号」入口，
-- 因此补 employee_no 列（工号登录）；手机号路径仍走 users.phone_hash（Digests.sha256Hex）。
-- 唯一约束允许 NULL（多数医生暂未分配工号时互不影响）。
ALTER TABLE doctors ADD COLUMN employee_no VARCHAR(32) NULL;
ALTER TABLE doctors ADD CONSTRAINT uk_doctors_employee_no UNIQUE (employee_no);
