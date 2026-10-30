-- =====================================================================
-- V9008__slot_rebuild_seed.sql —— 重建未来 14 天号源（2026-10-24）
-- ⚠️ 仅 dev profile 加载。
-- 幂等：INSERT ... ON DUPLICATE KEY UPDATE，可重复执行不报错。
-- 背景：V9000 号源以执行日为基准未来 7 天，执行日已过 → 今天窗口内无号源
--       → 前端选时段显示「该时段暂无号源」。本文件按执行日重建未来 14 天。
-- =====================================================================

-- ---------- 未来 14 天 × 上午/下午各一档，capacity/remaining=20 ----------
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
SELECT
  CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-am'),
  d.id,
  TIMESTAMP(day.d, '09:00:00'),
  TIMESTAMP(day.d, '09:30:00'),
  20, 20, 25.00, 'CNY', 'OPEN'
FROM doctors d,
     (SELECT CURDATE() + INTERVAL n DAY AS d
      FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
            UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9
            UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13) nums) day
ON DUPLICATE KEY UPDATE capacity = 20, remaining = 20, status = 'OPEN', updated_at = CURRENT_TIMESTAMP(3);

INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
SELECT
  CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-pm'),
  d.id,
  TIMESTAMP(day.d, '14:00:00'),
  TIMESTAMP(day.d, '14:30:00'),
  20, 20, 25.00, 'CNY', 'OPEN'
FROM doctors d,
     (SELECT CURDATE() + INTERVAL n DAY AS d
      FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
            UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9
            UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13) nums) day
ON DUPLICATE KEY UPDATE capacity = 20, remaining = 20, status = 'OPEN', updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 顺手把过期号源（start_time < NOW()）关闭，避免 hasAvailableSlot 误判 ----------
UPDATE doctor_slots SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP(3)
WHERE status = 'OPEN' AND start_time < NOW();
