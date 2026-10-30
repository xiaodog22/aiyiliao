-- =====================================================================
-- V9007__slot_reset_seed.sql —— 演示号源一键充裕化 dev 种子（2026-10-24）
-- ⚠️ 仅 dev profile 加载；不进入生产迁移。
-- 幂等：纯 UPDATE，可重复执行不报错。
-- 背景：V9000 种子号源 capacity=5，演示几轮后被约完 → 前端全显示「约满」。
-- 动作：所有 OPEN 号源容量与剩余统一重置为 20（空余20）。
-- 运行时一键重置见 DevAdminController（POST /api/v1/dev/slots/reset）。
-- =====================================================================

UPDATE doctor_slots
SET capacity = 20, remaining = 20, updated_at = CURRENT_TIMESTAMP(3)
WHERE status = 'OPEN';
