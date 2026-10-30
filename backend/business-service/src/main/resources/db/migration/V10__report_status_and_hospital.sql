-- =====================================================================
-- V10__report_status_and_hospital.sql —— 报告状态与就诊机构（2026-10-19）
-- 事实源：docs/接口需求_待后端实现_20261019.md §F1
-- 约定：utf8mb4；时间 UTC；只加列，不改既有列语义。
-- 说明：
--   1) health_records.report_status：报告出具状态（READY/PENDING/REVIEWING）；
--      NULL = 非报告类或状态未知，客户端整个徽标不渲染（契约 HealthRecord.reportStatus）。
--   2) health_records.hospital：就诊机构（效果图卡片副行「本院区 · 门诊检验」）；
--      NULL = 未记录，客户端不渲染该行。
-- 兼容：H2 MySQL 模式逐列 ALTER，不用 MySQL 多列合并语法。
-- =====================================================================

ALTER TABLE health_records ADD COLUMN report_status VARCHAR(12) NULL;
ALTER TABLE health_records ADD COLUMN hospital VARCHAR(60) NULL;
