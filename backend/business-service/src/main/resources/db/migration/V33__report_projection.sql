-- =====================================================================
-- V33__report_projection.sql —— 报告来源投影 + READY 消息幂等（2026-11-20）
--
-- 背景（P0-3）：报告只能被动查、无来源追溯；REVIEWING/PENDING → READY 时无主动提醒。
-- 本迁移只增列/索引，不改历史行、不删列：
--   1) health_report_details 补「关联检查申请号」「报告级参考区间说明」；
--      来源系统沿用既有 data_origin，外部报告号沿用 external_report_id，
--      审核者沿用 reviewer_name（不重复造列，避免三处口径）。
--   2) messages 补 biz_key：业务事件幂等键（当前用于 REPORT_READY:{recordId}），
--      唯一索引 (user_id, biz_key)；历史消息 biz_key 为 NULL，不受影响。
-- 依赖：V27 已建 health_report_details；V21 已建 messages。
-- 注意：V34 起为支付订单表（计划中），本文件占用 V33 后支付/检查顺延为 V34/V35。
-- =====================================================================

ALTER TABLE health_report_details
    ADD COLUMN exam_request_no VARCHAR(64) NULL COMMENT '关联检查申请号（P0-2 检查预约链路；可空）' AFTER external_report_id,
    ADD COLUMN reference_range_note VARCHAR(512) NULL COMMENT '报告级参考区间说明（项目级参考区间仍以 health_report_items 快照为准）' AFTER recommendation_text;

ALTER TABLE messages
    ADD COLUMN biz_key VARCHAR(128) NULL COMMENT '业务事件幂等键；同用户同键只写 1 条' AFTER ref_id,
    ADD UNIQUE KEY uq_messages_user_biz (user_id, biz_key);

-- =====================================================================
-- 回滚（只允许后续修复迁移，禁止 DROP 整库）：
--   ALTER TABLE messages DROP INDEX uq_messages_user_biz, DROP COLUMN biz_key;
--   ALTER TABLE health_report_details DROP COLUMN reference_range_note, DROP COLUMN exam_request_no;
-- =====================================================================
