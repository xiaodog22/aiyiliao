-- =====================================================================
-- V35__exam_orders.sql —— 检查预约（P0-2，2026-11-20）
--
-- 边界：
--   · 仅演示排期，不接真实医院检查号源；source 固定 DEMO。
--   · 平台按 requestNo（检查申请号）幂等；clinic-his 按 appId+requestNo / item+slot 双防线。
--   · 同一用户同一 Idempotency-Key 只建 1 单；同一 requestNo 只建 1 单。
--   · 金额取 HIS 项目价，客户端不传金额。
--
-- 关联：
--   · his_order_no → clinic-his openapi_exam_orders.exam_order_no
--   · request_no   → 报告投影 health_report_details.exam_request_no（P0-3）
-- =====================================================================

CREATE TABLE IF NOT EXISTS exam_orders (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    request_no      VARCHAR(64)  NOT NULL COMMENT '平台检查申请号（EXR…）',
    user_id         VARCHAR(64)  NOT NULL,
    family_member_id VARCHAR(64) NULL,
    patient_name    VARCHAR(50)  NOT NULL,
    item_code       VARCHAR(32)  NOT NULL,
    item_name       VARCHAR(80)  NOT NULL,
    price           DECIMAL(10,2) NOT NULL DEFAULT 0,
    slot_key        VARCHAR(32)  NOT NULL,
    slot_date       DATE         NOT NULL,
    slot_time       VARCHAR(8)   NOT NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'BOOKED' COMMENT 'BOOKED/CANCELLED/COMPLETED',
    his_order_no    VARCHAR(64)  NULL COMMENT 'clinic-his 检查预约号 EXM…',
    source          VARCHAR(16)  NOT NULL DEFAULT 'DEMO' COMMENT '仅 DEMO',
    idem_key        VARCHAR(128) NOT NULL,
    last_error      VARCHAR(255) NULL,
    created_at      DATETIME(3)  NOT NULL,
    updated_at      DATETIME(3)  NOT NULL,
    cancelled_at    DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_exam_request_no (request_no),
    UNIQUE KEY uq_exam_user_idem (user_id, idem_key),
    UNIQUE KEY uq_exam_his_order (his_order_no),
    KEY idx_exam_user_status (user_id, status),
    KEY idx_exam_slot (item_code, slot_key, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='检查预约（演示排期）';

-- =====================================================================
-- 回滚（只允许后续修复迁移，禁止 DROP 整库）：
--   DROP TABLE exam_orders;
-- =====================================================================
