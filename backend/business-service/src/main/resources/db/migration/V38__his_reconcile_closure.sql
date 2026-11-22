-- =====================================================================
-- V38__his_reconcile_closure.sql —— HIS 撤销补偿与对账差异闭环（2026-11-22）
--
-- 背景（敌意审查 L5）：
--   1) 取消预约时 HIS 撤销失败只 log.warn（cancelQuietly），进程重启后线索全丢，
--      「平台已取消、医院仍有受理单」永久不一致；
--   2) 演示退费只改本地状态，订单从 reconcile 的 PAID 视野中消失，
--      HIS 侧账单恒 PAID 却无人发现。
--
-- 本迁移只新增两张表，不改既有表/唯一键：
--   · his_cancel_tasks     —— 取消补偿 outbox（与本地取消同事务入队，定时重试；
--                              attempts 达上限置 DEAD 等人工，绝不静默丢弃）
--   · his_reconcile_diffs  —— 对账差异台账（OPEN/RESOLVED；重复对账幂等 upsert）
--
-- 回滚（只允许后续修复迁移，禁止 DROP 整库）：
--   DROP TABLE his_cancel_tasks;
--   DROP TABLE his_reconcile_diffs;
-- =====================================================================

CREATE TABLE IF NOT EXISTS his_cancel_tasks (
    id             BIGINT       NOT NULL AUTO_INCREMENT,
    appointment_id VARCHAR(64)  NOT NULL COMMENT '本地预约 ID（一个预约只允许一条补偿任务）',
    his_order_no   VARCHAR(64)  NOT NULL COMMENT 'HIS 受理单号',
    reason         VARCHAR(255) NULL,
    status         VARCHAR(16)  NOT NULL DEFAULT 'PENDING' COMMENT 'PENDING/DONE/DEAD',
    attempts       INT          NOT NULL DEFAULT 0,
    last_error     VARCHAR(255) NULL,
    next_retry_at  DATETIME(3)  NOT NULL,
    created_at     DATETIME(3)  NOT NULL,
    updated_at     DATETIME(3)  NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_his_cancel_appointment (appointment_id),
    KEY idx_his_cancel_due (status, next_retry_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='HIS 撤销补偿 outbox（L5）';

CREATE TABLE IF NOT EXISTS his_reconcile_diffs (
    id              BIGINT       NOT NULL AUTO_INCREMENT,
    biz_type        VARCHAR(16)  NOT NULL COMMENT 'PAYMENT（当前仅支付对账）',
    biz_id          VARCHAR(64)  NOT NULL COMMENT '支付单号 order_no',
    expected_status VARCHAR(16)  NOT NULL COMMENT '本地期望状态：PAID/REFUNDED',
    actual_status   VARCHAR(16)  NOT NULL COMMENT 'HIS 实际状态；查询失败为 UNKNOWN',
    detail          VARCHAR(255) NULL,
    status          VARCHAR(16)  NOT NULL DEFAULT 'OPEN' COMMENT 'OPEN/RESOLVED',
    first_seen_at   DATETIME(3)  NOT NULL,
    last_seen_at    DATETIME(3)  NOT NULL,
    resolved_at     DATETIME(3)  NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_his_reconcile_biz (biz_type, biz_id),
    KEY idx_his_reconcile_status (status, last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='HIS 对账差异台账（L5）';
