-- =====================================================================
-- V37__payment_refund.sql —— 演示退费状态（2026-11-21）
--
-- 背景：P0-1 只有「建单 → 支付」两态；退费无契约、无字段、无入口。
-- 本轮先落「演示退费」：仅本地状态流转，不调用任何真实支付网关，
-- 也不触发 clinic-his 退费（其退费接口未在 openapi 暴露）。
--   · status: UNPAID / PAID / REFUNDED
--   · refund_channel 固定 LOCAL_DEMO，便于日后接入真实退款时区分口径
--   · refunded_at / refund_reason 为审计字段，页面只展示状态
--
-- 兼容性：只加列，不改旧列、不改唯一键；旧代码 SELECT 指定列不受影响。
-- 回滚（后续修复迁移）：
--   ALTER TABLE payment_orders DROP COLUMN refund_channel;
--   ALTER TABLE payment_orders DROP COLUMN refund_reason;
--   ALTER TABLE payment_orders DROP COLUMN refunded_at;
-- =====================================================================

ALTER TABLE payment_orders ADD COLUMN refunded_at DATETIME(3) NULL COMMENT '演示退费时间（本地状态）';

ALTER TABLE payment_orders ADD COLUMN refund_reason VARCHAR(255) NULL COMMENT '退费原因（演示）';

ALTER TABLE payment_orders ADD COLUMN refund_channel VARCHAR(16) NULL COMMENT '退费通道：LOCAL_DEMO';
