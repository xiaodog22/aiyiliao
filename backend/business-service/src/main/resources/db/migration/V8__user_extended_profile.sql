-- =====================================================================
-- V8__user_extended_profile.sql —— 个人信息设置扩展（2026-10-17）
-- 用户诉求：个人信息页可维护 姓名/头像/电话/邮箱/住宅/户籍/医保绑定/身份证实名。
-- 设计：
--   1:1 于 users 的扩展表（不在 users 上加列）：联系方式/住址为一般个人信息（明文），
--   身份证号与医保号为高敏证件号 —— 与 phone 同口径 AES-GCM 密文落库 + SHA-256 哈希列，
--   响应永不回显原文（仅掩码 + 绑定状态）。
-- 约定沿用 V1：utf8mb4、DATETIME(3) UTC、主键应用生成 VARCHAR(64)、version 乐观锁。
-- =====================================================================

CREATE TABLE user_extended (
    id                    VARCHAR(64)    NOT NULL,
    user_id               VARCHAR(64)    NOT NULL,
    -- 一般个人信息（明文；非证件号，页面按"未填不显示"处理）
    email                 VARCHAR(120)   NULL,
    residence             VARCHAR(200)   NULL,
    household_registration VARCHAR(200)  NULL,
    -- 身份证实名：姓名明文（回显所需），号码密文 + 哈希（哈希用于防重复绑定排查）
    id_card_name          VARCHAR(40)    NULL,
    id_card_cipher        VARBINARY(512) NULL,
    id_card_hash          VARCHAR(64)    NULL,
    id_card_verified      TINYINT(1)     NOT NULL DEFAULT 0,
    -- 医保绑定：类型明文（枚举文案），号码密文 + 哈希
    insurance_type        VARCHAR(20)    NULL,
    insurance_no_cipher   VARBINARY(512) NULL,
    insurance_no_hash     VARCHAR(64)    NULL,
    insurance_bound       TINYINT(1)     NOT NULL DEFAULT 0,
    version               INT            NOT NULL DEFAULT 1,
    created_at            DATETIME(3)    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at            DATETIME(3)    NULL DEFAULT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uk_user_extended_user (user_id),
    CONSTRAINT fk_user_extended_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
