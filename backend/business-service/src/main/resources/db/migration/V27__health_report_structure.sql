-- =====================================================================
-- V27__health_report_structure.sql —— 电子检查报告数据体系（2026-11-05）
--
-- 背景：health_records 现为「单条摘要式」健康档案（summary 一段文本），
--       不足以承载专业检查报告的项目 / 数值 / 单位 / 参考区间 / 异常标记。
-- 原则：保留 health_records 为主表，增量扩展；不删表、不改历史行、不动已有迁移。
-- 设计依据：backend/deploy/DB_SCHEMA_DESIGN_20261105.md（阶段 02 定稿）。
--
-- 约定沿用 V1：InnoDB / utf8mb4_unicode_ci / DATETIME(3) UTC /
--              VARCHAR(64) 应用生成主键 / 迁移只追加不覆盖。
-- ⚠️ MySQL DDL 隐式提交：本文件失败会留下部分结构，须用恢复点或后续修复迁移，
--    不能当作可回滚事务。执行前备份：
--    .trash/db-backup-20261105/pre-report-audit-20261105.sql
-- =====================================================================

-- ---------- 1. 复合外键的前置被引用键（当前两表均缺失） ----------
ALTER TABLE health_records
    ADD UNIQUE KEY uq_health_records_id_user (id, user_id);

ALTER TABLE family_members
    ADD UNIQUE KEY uq_family_members_user_id (user_id, id);

-- ---------- 2. 索引：以真实 Repository SQL + EXPLAIN 为准 ----------
-- HealthRecordRepository.list 过滤 user_id + family_member_id，排序 recorded_at,id。
-- 迁移前 EXPLAIN：ref(uq_health_records_idem) + Using filesort（见设计文档 §1）。
ALTER TABLE health_records
    ADD KEY idx_hr_user_family_time (user_id, family_member_id, recorded_at, id);

-- 报告列表按状态筛选（任务书 §3.4）；不建 (user_id, category, recorded_at)：
-- 真实列表 SQL 无 category 条件，该组合索引不会被使用。
ALTER TABLE health_records
    ADD KEY idx_hr_user_status_time (user_id, report_status, recorded_at);

-- ---------- 3. 关联完整性：家属必须是当前账号的成员 ----------
-- family_member_id 为 NULL 时 MySQL MATCH SIMPLE 跳过校验，历史 7 条档案不受影响。
ALTER TABLE health_records
    ADD CONSTRAINT fk_health_records_family
    FOREIGN KEY (user_id, family_member_id) REFERENCES family_members (user_id, id);

-- ---------- 4. 关联完整性：附件用户归属必须与档案一致 ----------
-- 保留 V9 的两个单列 FK；新增复合 FK 锁死 (record_id, user_id) 组合。
ALTER TABLE health_record_attachments
    ADD CONSTRAINT fk_hr_attach_record_user
    FOREIGN KEY (record_id, user_id) REFERENCES health_records (id, user_id) ON DELETE CASCADE;

-- ---------- 5. 附件表扩展用途（二进制仍不入库） ----------
ALTER TABLE health_record_attachments
    ADD COLUMN attachment_type    VARCHAR(24)  NOT NULL DEFAULT 'REPORT',
    ADD COLUMN display_name       VARCHAR(255) NULL,
    ADD COLUMN sort_order         INT          NOT NULL DEFAULT 0,
    ADD COLUMN preview_object_key VARCHAR(64)  NULL,
    ADD KEY idx_hr_attach_type_sort (record_id, attachment_type, sort_order);

-- ---------- 6. 医疗机构目录（独立演示机构，不替换现有医院名） ----------
CREATE TABLE medical_institutions (
    id                VARCHAR(64)  NOT NULL,
    institution_code  VARCHAR(64)  NOT NULL,
    institution_name  VARCHAR(200) NOT NULL,
    institution_type  VARCHAR(24)  NOT NULL DEFAULT 'HOSPITAL',
    hospital_level    VARCHAR(32)  NULL,
    address           VARCHAR(300) NULL,
    telephone         VARCHAR(40)  NULL,
    status            VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    is_demo           TINYINT(1)   NOT NULL DEFAULT 0,
    created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at        DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_med_inst_code (institution_code),
    KEY idx_med_inst_status (status, institution_type)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------- 7. 报告基本信息（1:1 于 health_records） ----------
-- 刻意不复制主表已有字段：category / title / summary / recorded_at /
-- hospital / report_status / doctor_name / abnormal 均留在 health_records。
CREATE TABLE health_report_details (
    id                        VARCHAR(64)  NOT NULL,
    record_id                 VARCHAR(64)  NOT NULL,
    user_id                   VARCHAR(64)  NOT NULL,
    report_no                 VARCHAR(64)  NOT NULL,
    report_type               VARCHAR(24)  NOT NULL DEFAULT 'LAB',
    institution_id            VARCHAR(64)  NULL,
    department_id             VARCHAR(64)  NULL,
    department_name_snapshot  VARCHAR(120) NULL,
    patient_name_snapshot     VARCHAR(80)  NULL,
    patient_sex_snapshot      VARCHAR(16)  NULL,
    patient_age_snapshot      VARCHAR(32)  NULL,
    outpatient_no             VARCHAR(64)  NULL,
    inpatient_no              VARCHAR(64)  NULL,
    clinical_diagnosis        VARCHAR(500) NULL,
    applicant_doctor          VARCHAR(80)  NULL,
    specimen_type             VARCHAR(64)  NULL,
    specimen_no               VARCHAR(64)  NULL,
    collection_at             DATETIME(3)  NULL,
    received_at               DATETIME(3)  NULL,
    tested_at                 DATETIME(3)  NULL,
    reported_at               DATETIME(3)  NULL,
    operator_name             VARCHAR(80)  NULL,
    reviewer_name             VARCHAR(80)  NULL,
    inspection_method         VARCHAR(200) NULL,
    instrument_model          VARCHAR(120) NULL,
    findings_text             TEXT         NULL,
    impression_text           TEXT         NULL,
    conclusion_text           TEXT         NULL,
    recommendation_text       TEXT         NULL,
    data_origin               VARCHAR(24)  NOT NULL DEFAULT 'DEMO',
    external_report_id        VARCHAR(128) NULL,
    is_demo                   TINYINT(1)   NOT NULL DEFAULT 1,
    demo_notice               VARCHAR(200) NULL,
    version                   INT          NOT NULL DEFAULT 1,
    created_at                DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at                DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_hrd_record (record_id),
    UNIQUE KEY uq_hrd_id_user (id, user_id),
    UNIQUE KEY uq_hrd_report_no (report_no),
    KEY idx_hrd_user_time (user_id, reported_at),
    KEY idx_hrd_type_time (report_type, reported_at),
    CONSTRAINT fk_hrd_record_user FOREIGN KEY (record_id, user_id)
        REFERENCES health_records (id, user_id) ON DELETE CASCADE,
    CONSTRAINT fk_hrd_institution FOREIGN KEY (institution_id)
        REFERENCES medical_institutions (id),
    CONSTRAINT fk_hrd_department FOREIGN KEY (department_id)
        REFERENCES departments (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------- 8. 报告分组 ----------
CREATE TABLE health_report_sections (
    id                VARCHAR(64)  NOT NULL,
    report_detail_id  VARCHAR(64)  NOT NULL,
    user_id           VARCHAR(64)  NOT NULL,
    section_code      VARCHAR(48)  NOT NULL,
    section_name      VARCHAR(120) NOT NULL,
    sort_order        INT          NOT NULL DEFAULT 0,
    created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_hrs_id_user (id, user_id),
    UNIQUE KEY uq_hrs_detail_code (report_detail_id, section_code),
    KEY idx_hrs_detail_sort (report_detail_id, sort_order),
    CONSTRAINT fk_hrs_detail FOREIGN KEY (report_detail_id)
        REFERENCES health_report_details (id) ON DELETE CASCADE,
    CONSTRAINT fk_hrs_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------- 9. 检查项目明细（数值型 / 定性型 / 描述型并存） ----------
-- result_value 与 reference_low/high 用 DECIMAL；描述型报告只用 result_text +
-- findings_text/impression_text，不强制填数值。
-- 参考区间是「报告出具时的实际快照」，不建全局固定标准表。
CREATE TABLE health_report_items (
    id                VARCHAR(64)   NOT NULL,
    report_detail_id  VARCHAR(64)   NOT NULL,
    section_id        VARCHAR(64)   NULL,
    user_id           VARCHAR(64)   NOT NULL,
    item_code         VARCHAR(64)   NULL,
    item_name         VARCHAR(160)  NOT NULL,
    result_value      DECIMAL(18,4) NULL,
    result_text       VARCHAR(1000) NULL,
    unit              VARCHAR(40)   NULL,
    reference_low     DECIMAL(18,4) NULL,
    reference_high    DECIMAL(18,4) NULL,
    reference_text    VARCHAR(160)  NULL,
    abnormal_flag     VARCHAR(20)   NOT NULL DEFAULT 'NORMAL',
    inspection_method VARCHAR(200)  NULL,
    remark            VARCHAR(500)  NULL,
    sort_order        INT           NOT NULL DEFAULT 0,
    created_at        DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_hri_section_sort (section_id, sort_order),
    KEY idx_hri_detail_sort (report_detail_id, sort_order),
    KEY idx_hri_user_abnormal (user_id, abnormal_flag),
    CONSTRAINT fk_hri_section_user FOREIGN KEY (section_id, user_id)
        REFERENCES health_report_sections (id, user_id) ON DELETE CASCADE,
    CONSTRAINT fk_hri_detail FOREIGN KEY (report_detail_id)
        REFERENCES health_report_details (id) ON DELETE CASCADE,
    CONSTRAINT fk_hri_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- =====================================================================
-- 回滚（仅恢复点/后续修复迁移，禁止 DROP 整库）：
--   mysql < .trash/db-backup-20261105/pre-report-audit-20261105.sql
-- 或新增 V28 显式 DROP TABLE health_report_items / sections / details /
--   medical_institutions 与 DROP 新增索引/外键/列。
-- =====================================================================
