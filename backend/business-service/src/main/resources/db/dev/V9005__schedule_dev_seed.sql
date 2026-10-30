-- =====================================================================
-- V9005__schedule_dev_seed.sql —— 排班/在线状态 dev 种子（2026-10-22）
-- ⚠️ 仅 dev profile 加载（application.yml 在 dev 追加 classpath:db/dev）。
-- 幂等：ON DUPLICATE KEY UPDATE / 先删后插，可重复执行。
-- 内容：doc-gastro-1（= dev-user-2 的医生任职）工作日上午 09:00-12:00 出诊，
--   每号 30 分钟、可约 3 人；并置为在线接诊，便于患者侧 availability 与
--   医生端排班页有真实演示数据。
-- 红线：只写开发演示数据，不进入生产迁移（生产不回填排班）。
-- =====================================================================

-- 先清掉该医生的演示排班，避免重复执行时叠加（仅限本医生 id）
DELETE FROM doctor_schedules WHERE doctor_id = 'doc-gastro-1';

INSERT INTO doctor_schedules
    (id, doctor_id, weekday, start_time, end_time, slot_minutes, capacity, online_only, version, created_at, updated_at)
VALUES
    ('sched-gastro-1-mon', 'doc-gastro-1', 1, '09:00:00', '12:00:00', 30, 3, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('sched-gastro-1-tue', 'doc-gastro-1', 2, '09:00:00', '12:00:00', 30, 3, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('sched-gastro-1-wed', 'doc-gastro-1', 3, '09:00:00', '12:00:00', 30, 3, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('sched-gastro-1-thu', 'doc-gastro-1', 4, '09:00:00', '12:00:00', 30, 3, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('sched-gastro-1-fri', 'doc-gastro-1', 5, '09:00:00', '12:00:00', 30, 3, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
    ('sched-gastro-1-fri-pm', 'doc-gastro-1', 5, '14:00:00', '17:00:00', 30, 2, 1, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE
    start_time = VALUES(start_time), end_time = VALUES(end_time),
    slot_minutes = VALUES(slot_minutes), capacity = VALUES(capacity),
    online_only = VALUES(online_only), updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO doctor_online_status (doctor_id, online, accepting, version, updated_at)
VALUES ('doc-gastro-1', 1, 1, 1, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE online = VALUES(online), accepting = VALUES(accepting),
    updated_at = CURRENT_TIMESTAMP(3);
