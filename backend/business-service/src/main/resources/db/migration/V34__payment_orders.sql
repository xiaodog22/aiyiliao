-- =====================================================================
-- V34__payment_orders.sql —— 演示支付订单（P0-1，2026-11-20）
--
-- 边界（D1，见 docs/HIS差距修复计划_20261120.md）：
--   · 不接微信支付/商户号，不调用 wx.requestPayment；本表只承载「演示支付闭环」。
--   · source 只允许 DEMO / SANDBOX；页面固定标注「演示支付成功（未真实扣款）」。
--   · 真实扣款能力上线前，本表数据不得作为收费凭证；对账只比对 HIS 演示账单状态。
--
-- 关联：
--   · appointment_id → appointments.id（金额以号源 doctor_slots.fee 为准，不信任客户端）
--   · charge_no      → clinic-his charges.charge_no（演示账单由 /openapi/v1/demo/charges 创建）
--
-- 幂等：
--   · 同一用户同一 Idempotency-Key 只建 1 单（uq_payment_user_idem）
--   · 同一预约只建 1 单（uq_payment_appointment）
--   · 同一 HIS 账单只对应 1 单（uq_payment_charge）
-- =====================================================================

CREATE TABLE IF NOT EXISTS payment_orders (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    order_no       VARCHAR(32)  NOT NULL COMMENT '平台支付单号（PAY+yyyyMMddHHmmss+序号）',
    user_id        VARCHAR(64)  NOT NULL,
    appointment_id VARCHAR(64)  NOT NULL,
    charge_no      VARCHAR(64)  NOT NULL COMMENT 'clinic-his 演示账单号',
    amount         DECIMAL(10,2) NOT NULL COMMENT '元；服务端按号源费落库',
    currency       VARCHAR(8)   NOT NULL DEFAULT 'CNY',
    status         VARCHAR(16)  NOT NULL DEFAULT 'UNPAID' COMMENT 'UNPAID/PAID/FAILED/CLOSED',
    source         VARCHAR(16)  NOT NULL COMMENT 'DEMO/SANDBOX；真实支付未启用',
    idem_key       VARCHAR(128) NOT NULL COMMENT '建单幂等键',
    last_error     VARCHAR(255) NULL,
    created_at     DATETIME(3)  NOT NULL,
    updated_at     DATETIME(3)  NOT NULL,
    paid_at        DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_payment_order_no (order_no),
    UNIQUE KEY uq_payment_user_idem (user_id, idem_key),
    UNIQUE KEY uq_payment_appointment (appointment_id),
    UNIQUE KEY uq_payment_charge (charge_no),
    KEY idx_payment_status (status),
    KEY idx_payment_paid_at (paid_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='演示支付订单（非真实扣款）';

-- =====================================================================
-- 回滚（只允许后续修复迁移，禁止 DROP 整库）：
--   DROP TABLE payment_orders;
-- =====================================================================
