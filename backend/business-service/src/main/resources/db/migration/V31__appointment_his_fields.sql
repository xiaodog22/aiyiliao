-- REQ-14：HIS 受限接入（V1.20）——业务单号 + 预约来源标识。
-- 只加列、不改既有行语义：历史行 booking_source 默认 LOCAL_DEMO（本地演示预约），
-- his_order_no 为 NULL（从未对接 HIS）。上线前须由 PRODUCTION_GATE.md PG-02 决策是否接真实 HIS。
ALTER TABLE appointments ADD COLUMN his_order_no VARCHAR(64) NULL;

ALTER TABLE appointments ADD COLUMN booking_source VARCHAR(16) NOT NULL DEFAULT 'LOCAL_DEMO';
