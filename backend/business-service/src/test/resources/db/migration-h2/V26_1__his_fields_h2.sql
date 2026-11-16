-- H2 单测专用补丁：REQ-14（生产 V31）的 H2 等价物。
--
-- 背景：application-itest.yml / application-prodtest.yml 把 Flyway target 锁在 26，
--   因为 V27+ 含 MySQL 专有 DDL（ALTER ... ADD COLUMN a, ADD COLUMN b, ADD KEY），
--   H2 MODE=MySQL 无法解析，会让全部 @SpringBootTest 上下文启动失败。
--   因此 V31 永远不会在 H2 执行，而通用 APPT_COLS 已包含 his_order_no / booking_source，
--   若不补列，所有预约相关单测都会因「Column not found」500。
--
-- 隔离边界：本文件只存在于 classpath:db/migration-h2，**生产 locations 不含该目录**；
--   生产库仍由 db/migration/V31__appointment_his_fields.sql 加列。两边字段语义一致。
ALTER TABLE appointments ADD COLUMN his_order_no VARCHAR(64) NULL;

ALTER TABLE appointments ADD COLUMN booking_source VARCHAR(16) DEFAULT 'LOCAL_DEMO' NOT NULL;
