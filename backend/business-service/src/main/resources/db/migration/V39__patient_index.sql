-- =====================================================================
-- V39__patient_index.sql —— 患者主索引 + 平台↔HIS 患者映射（2026-11-27）
--
-- 背景（P3 病历/报告前置）：两端唯一的患者身份是 HIS 用「appId + 姓名」派生的
-- DEMO- 档案，姓名即身份。本迁移只建索引与映射表，不迁移 HIS 业务数据、不做双写。
--
-- 关键设计（owner 2026-11-27 定稿，评审时确认过的两条硬约束）：
--   1) his_patient_id 全局唯一 —— 一个 HIS 档案只能归属一个平台就诊人；
--      canonical 唯一性用生成列 canonical_key（仅 CONFIRMED 有值）表达，
--      ALIAS / SEED_FIXTURE 行因此有处落脚，并保留「一就诊人 N 条 HIS 档案」的表达力。
--   2) 证件号哈希存「HIS 兼容口径」（sha256(salt + id)），由 business 解密后重算；
--      与 user_extended.id_card_hash（无盐 sha256）不是同一哈希空间，禁止互相比较。
--
-- 状态机：CONFIRMED（唯一 canonical）/ ALIAS（同一人的其它 HIS 档案、种子档案）/
--         CONFLICT（同名多档无法区分，读取一律 409）/ UNMAPPED（平台有、HIS 无）/
--         ORPHAN（HIS 有、平台无，禁止读取）。
-- =====================================================================

CREATE TABLE IF NOT EXISTS patient_index (
    patient_ref       VARCHAR(64)  NOT NULL COMMENT '平台就诊人 ID：pat-<uuid>，改名不换 ID',
    owner_user_id     VARCHAR(64)  NOT NULL COMMENT '归属用户 users.id（维权/代挂号都落到具体就诊人）',
    family_member_id  VARCHAR(64)  NULL     COMMENT '家人档案 family_members.id；NULL=本人',
    display_name      VARCHAR(40)  NOT NULL COMMENT '就诊人姓名（明文，展示用）',
    name_hash         CHAR(64)     NULL     COMMENT '姓名 HMAC，仅用于同名去重，不作唯一认定',
    birth_date        DATE         NULL,
    sex               VARCHAR(8)   NULL,
    -- 只在证件号通过 18 位 + GB 11643 校验位后才写入；否则保持 NULL
    id_card_hash      CHAR(64)     NULL     COMMENT '证件号哈希（HIS 兼容盐口径，与 patients.id_hash 可比）',
    id_last4          CHAR(4)      NULL     COMMENT '证件尾号，仅展示/人工核对',
    phone_hash        CHAR(64)     NULL,
    phone_mask        VARCHAR(20)  NULL     COMMENT '手机掩码 138****8000（只存掩码与哈希，不存明文）',
    verification_level VARCHAR(16) NOT NULL DEFAULT 'NONE' COMMENT 'NONE / PROFILE / ID_VERIFIED',
    identity_source   VARCHAR(16)  NOT NULL DEFAULT 'USER_INPUT'
        COMMENT 'USER_INPUT / FAMILY_MEMBER / LEGACY_APPOINTMENT / SEED_FIXTURE；仅前两类可进 T1/T2',
    status            VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / ARCHIVED（不物理删除）',
    version           INT          NOT NULL DEFAULT 1,
    -- 幂等（与 family_members 同口径）：同键同摘要返回原记录，同键异摘要 409
    idempotency_key   VARCHAR(128) NULL,
    request_digest    CHAR(64)     NULL,
    created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at        DATETIME(3)  NULL DEFAULT NULL,
    PRIMARY KEY (patient_ref),
    -- 唯一性按「同一用户 + 同一就诊人姓名」：一个账号可以替多个不同姓名的人挂号
    -- （实测 u-dev-user-1 名下就有张三/链路验收/李四等 5 个姓名，且 family_member_id 全为空），
    -- 因此不能按 family_member_id 或「本人」占位来唯一化。
    UNIQUE KEY uq_patient_index_owner_name (owner_user_id, display_name),
    UNIQUE KEY uq_patient_index_idem (owner_user_id, idempotency_key),
    KEY idx_patient_index_family (family_member_id),
    KEY idx_patient_index_name_hash (name_hash),
    KEY idx_patient_index_id_hash (id_card_hash),
    KEY idx_patient_index_owner_status (owner_user_id, status),
    CONSTRAINT fk_patient_index_user FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台就诊人主索引（与 HIS 患者档案解耦，改名不换 ID）';

CREATE TABLE IF NOT EXISTS his_patient_map (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    platform_id    VARCHAR(64)  NOT NULL COMMENT '= patient_index.patient_ref',
    his_patient_id VARCHAR(64)  NOT NULL COMMENT 'clinic-his patients.id（跨库，存字符串）',
    his_mrn        VARCHAR(64)  NOT NULL DEFAULT '' COMMENT 'clinic-his patients.mrn，人工核对用',
    status         VARCHAR(16)  NOT NULL COMMENT 'CONFIRMED / ALIAS / CONFLICT / UNMAPPED / ORPHAN',
    alias_reason   VARCHAR(32)  NULL     COMMENT 'ALIAS 细分：SEED_FIXTURE / MERGED / DUPLICATE',
    match_tier     VARCHAR(16)  NULL     COMMENT 'T1 / T2 / T3 / T4 / MANUAL / DEV_ONLY',
    evidence       VARCHAR(512) NULL     COMMENT '依据摘要（哈希因子 / 裁决单号 / DEV_ONLY 说明）',
    source_app_id  VARCHAR(64)  NULL     COMMENT 'HIS 侧建档 appId（openapi_keys.app_id），防跨 app 占用',
    decided_by     VARCHAR(64)  NULL     COMMENT '裁决人 userId（审计）',
    decided_at     DATETIME(3)  NULL,
    created_at     DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at     DATETIME(3)  NULL DEFAULT NULL,
    -- canonical 唯一：仅 CONFIRMED 行参与，NULL 不占位（等价于部分唯一索引）
    canonical_key  VARCHAR(64)  GENERATED ALWAYS AS (IF(status = 'CONFIRMED', platform_id, NULL)) STORED,
    PRIMARY KEY (id),
    UNIQUE KEY uq_hpm_his (his_patient_id),
    UNIQUE KEY uq_hpm_canonical (canonical_key),
    KEY idx_hpm_platform_status (platform_id, status),
    KEY idx_hpm_status (status),
    KEY idx_hpm_mrn (his_mrn)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='平台就诊人 ↔ HIS 患者档案映射（一就诊人可多条，canonical 唯一）';

-- 回滚（只允许后续修复迁移，禁止 DROP 整库）：
--   DROP TABLE his_patient_map;
--   DROP TABLE patient_index;
-- =====================================================================
