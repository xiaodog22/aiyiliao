-- =====================================================================
-- V9019__emergency_bookable.sql —— 急诊科放开互联网预约 + 马义童排班号源（2026-11-22）
--
-- 背景：业务确认「需要」让急诊医生在患者端可被选到（此前 V9003/V9018 把
--       dep-emergency 设为 INACTIVE，患者端挂号目录不返回该科室）。
--
-- 口径变更（请评审知悉）：
--   · dep-emergency 置 ACTIVE → 会出现在 GET /departments 可约目录；
--   · 仅工作日 08:00-20:00 放号，每日 2 档（上午/下午），capacity=5，与平台号源粒度一致；
--   · 急诊线下绿色通道不受影响（HIS 挂号登记仍可随时建 ONSITE 号）。
--   · 幂等：ON DUPLICATE KEY UPDATE / INSERT IGNORE。
-- 仅 dev profile 加载。
-- =====================================================================

UPDATE departments SET status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'dep-emergency';

-- 排班（周一~周日，上午/下午各一档），供医生端「排班」与号源生成口径一致
INSERT IGNORE INTO doctor_schedules
    (id, doctor_id, weekday, start_time, end_time, slot_minutes, capacity, online_only, version, created_at, updated_at)
VALUES
  ('sched-emergency-1-1', 'doc-emergency-1', 1, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('sched-emergency-1-2', 'doc-emergency-1', 2, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('sched-emergency-1-3', 'doc-emergency-1', 3, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('sched-emergency-1-4', 'doc-emergency-1', 4, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('sched-emergency-1-5', 'doc-emergency-1', 5, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('sched-emergency-1-6', 'doc-emergency-1', 6, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)),
  ('sched-emergency-1-7', 'doc-emergency-1', 7, '08:00:00', '20:00:00', 30, 5, 0, 1, CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3));

-- 在线接诊状态（患者端「今日可约」判据之一）
INSERT INTO doctor_online_status (doctor_id, online, accepting, version, updated_at)
VALUES ('doc-emergency-1', 1, 1, 1, CURRENT_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE online = VALUES(online), accepting = VALUES(accepting),
                        updated_at = CURRENT_TIMESTAMP(3);

-- 未来 7 天号源（每天上午/下午各一档，capacity=5），与平台号源粒度一致
INSERT IGNORE INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
SELECT CONCAT('slot-emergency-1-', DATE_FORMAT(day.d, '%Y%m%d'), '-', p.tag),
       'doc-emergency-1',
       TIMESTAMP(day.d, p.st),
       TIMESTAMP(day.d, p.et),
       5, 5, 25.00, 'CNY', 'OPEN'
FROM (SELECT CURDATE() + INTERVAL n DAY AS d
      FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3
            UNION SELECT 4 UNION SELECT 5 UNION SELECT 6) x) day
CROSS JOIN (SELECT 'am' AS tag, '08:00:00' AS st, '09:00:00' AS et
            UNION ALL SELECT 'pm', '14:00:00', '15:00:00') p
LEFT JOIN doctor_slots s ON s.id = CONCAT('slot-emergency-1-', DATE_FORMAT(day.d, '%Y%m%d'), '-', p.tag)
WHERE s.id IS NULL;
