-- H2 单测专用补丁：L5（生产 V37 + V38）的 H2 等价物。
--
-- H2 档 Flyway target 锁在 26.x，V37/V38 不会执行；缺列/缺表会让
-- HisReconcileClosureTest / PaymentService 对账查询直接报 Column/Table not found。
-- 与生产保持同一语义，仅去掉 MySQL 专有 COMMENT/ENGINE 语法。

-- V37 等价：演示退费三列
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS refunded_at TIMESTAMP(3) NULL;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS refund_reason VARCHAR(255) NULL;
ALTER TABLE payment_orders ADD COLUMN IF NOT EXISTS refund_channel VARCHAR(16) NULL;

-- V38 等价：HIS 取消补偿 outbox
CREATE TABLE IF NOT EXISTS his_cancel_tasks (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    appointment_id VARCHAR(64)  NOT NULL,
    his_order_no   VARCHAR(64)  NOT NULL,
    reason         VARCHAR(255) NULL,
    status         VARCHAR(16)  NOT NULL DEFAULT 'PENDING',
    attempts       INT          NOT NULL DEFAULT 0,
    last_error     VARCHAR(255) NULL,
    next_retry_at  TIMESTAMP(3) NOT NULL,
    created_at     TIMESTAMP(3) NOT NULL,
    updated_at     TIMESTAMP(3) NOT NULL,
    PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_his_cancel_appointment ON his_cancel_tasks (appointment_id);
CREATE INDEX idx_his_cancel_due ON his_cancel_tasks (status, next_retry_at);

-- V38 等价：HIS 对账差异台账
CREATE TABLE IF NOT EXISTS his_reconcile_diffs (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    biz_type        VARCHAR(16)  NOT NULL,
    biz_id          VARCHAR(64)  NOT NULL,
    expected_status VARCHAR(16)  NOT NULL,
    actual_status   VARCHAR(16)  NOT NULL,
    detail          VARCHAR(255) NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'OPEN',
    first_seen_at   TIMESTAMP(3) NOT NULL,
    last_seen_at    TIMESTAMP(3) NOT NULL,
    resolved_at     TIMESTAMP(3) NULL,
    PRIMARY KEY (id)
);
CREATE UNIQUE INDEX uq_his_reconcile_biz ON his_reconcile_diffs (biz_type, biz_id);
CREATE INDEX idx_his_reconcile_status ON his_reconcile_diffs (status, last_seen_at);
