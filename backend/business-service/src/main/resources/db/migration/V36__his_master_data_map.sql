-- =====================================================================
-- V36__his_master_data_map.sql —— 后端主数据 / HIS 辅助映射（A 方案）
--
-- 口径（2026-11-20 owner 决策）：
--   · MySQL 是平台主库；clinic-his 只做辅助回执/院内执行。
--   · 本表只做“逻辑映射”，不迁移 HIS 表、不做双写、不复制病历/处方/收费原文。
--   · status 三态：CONFIRMED（业务确认，可用于 HTTP 受理）/ CONFLICT（同名不同科等，
--     必须人工处理）/ UNMAPPED（未识别，禁止自动回落）。
--
-- 本迁移只建映射表 + 少量可证实的种子；不猜测科室/医生对应关系。
-- 已知事实：平台 16 科室/30 医生，HIS 13 科室/8 医生；仅“全科医学科/口腔科”名称一致；
-- 陈志远在平台为呼吸内科、在 HIS 为全科，属于同名不同科，标 CONFLICT。
-- =====================================================================

CREATE TABLE IF NOT EXISTS his_master_data_map (
    id            BIGINT       NOT NULL AUTO_INCREMENT,
    entity_type   VARCHAR(16)  NOT NULL COMMENT 'DEPARTMENT / DOCTOR / SLOT',
    platform_id   VARCHAR(64)  NOT NULL COMMENT '平台 ID：dep-* / doc-* / slot-*',
    his_id        VARCHAR(64)  NULL     COMMENT 'HIS ID：QK / D001 / SL*',
    status        VARCHAR(16)  NOT NULL DEFAULT 'UNMAPPED' COMMENT 'CONFIRMED / CONFLICT / UNMAPPED',
    note          VARCHAR(255) NULL,
    updated_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_his_map_platform (entity_type, platform_id),
    KEY idx_his_map_his (entity_type, his_id),
    KEY idx_his_map_status (entity_type, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='平台主数据 ↔ HIS 辅助映射（逻辑整合，不迁表）';

-- 只写可证实映射；UNMAPPED 不落行，避免把“未识别”误当成已映射。
INSERT IGNORE INTO his_master_data_map (entity_type, platform_id, his_id, status, note) VALUES
('DEPARTMENT', 'dep-gp',     'QK', 'CONFIRMED', '名称一致：全科医学科'),
('DEPARTMENT', 'dep-dental', 'KQ', 'CONFIRMED', '名称一致：口腔科'),
('DEPARTMENT', 'dep-ped',    'EK', 'CONFLICT',  '平台“儿科诊区” vs HIS“儿科”，名称不完全一致，待业务确认'),
('DOCTOR',     'doc-resp-1', 'D001', 'CONFLICT', '同名不同科：平台呼吸内科 vs HIS 全科，禁止自动映射');

-- 回滚（只允许后续修复迁移，禁止 DROP 整库）：
--   DROP TABLE his_master_data_map;
-- =====================================================================
