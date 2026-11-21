-- H2 单测专用补丁：P0-1（生产 V34）的 H2 等价物。
--
-- H2 档 Flyway target 锁在 26.x，不会执行 V34；支付接口若缺表会直接 500。
-- 字段/唯一约束与生产 V34 保持一致，仅去掉 MySQL 专有 COMMENT/ENGINE。
CREATE TABLE IF NOT EXISTS payment_orders (
    id             BIGINT        NOT NULL AUTO_INCREMENT,
    order_no       VARCHAR(32)   NOT NULL,
    user_id        VARCHAR(64)   NOT NULL,
    appointment_id VARCHAR(64)   NOT NULL,
    charge_no      VARCHAR(64)   NOT NULL,
    amount         DECIMAL(10,2) NOT NULL,
    currency       VARCHAR(8)    NOT NULL DEFAULT 'CNY',
    status         VARCHAR(16)   NOT NULL DEFAULT 'UNPAID',
    source         VARCHAR(16)   NOT NULL,
    idem_key       VARCHAR(128)  NOT NULL,
    last_error     VARCHAR(255)  NULL,
    created_at     TIMESTAMP(3)  NOT NULL,
    updated_at     TIMESTAMP(3)  NOT NULL,
    paid_at        TIMESTAMP(3)  NULL,
    PRIMARY KEY (id)
);

CREATE UNIQUE INDEX uq_payment_order_no ON payment_orders (order_no);
CREATE UNIQUE INDEX uq_payment_user_idem ON payment_orders (user_id, idem_key);
CREATE UNIQUE INDEX uq_payment_appointment ON payment_orders (appointment_id);
CREATE UNIQUE INDEX uq_payment_charge ON payment_orders (charge_no);
CREATE INDEX idx_payment_status ON payment_orders (status);
CREATE INDEX idx_payment_paid_at ON payment_orders (paid_at);
