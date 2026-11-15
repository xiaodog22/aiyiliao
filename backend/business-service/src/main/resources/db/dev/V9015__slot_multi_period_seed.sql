-- =====================================================================
-- V9015__slot_multi_period_seed.sql —— 号源扩容：每天 12 档，上下午各 6 档（2026-11-15）
--
-- 背景：V9008 起每天只有 09:00(-am) / 14:00(-pm) 两档，用户可选时间太少，
--       且前端默认落在「上午」，下午号源实际看不到。
-- 本迁移：未来 14 天 × 每位 ACTIVE 医生 × 12 档（30 分钟一档）：
--       上午 08:00 08:30 09:00 09:30 10:00 10:30（末档至 11:00）
--       下午 14:00 14:30 15:00 15:30 16:00 16:30（末档至 17:00）
--
-- ⚠️ 时区：库内 DATETIME 一律 UTC（连接串 forceConnectionTimeZoneToSession=true），
--    上面写的是**北京时间**，落库前必须 -8 HOUR（V9012 已把旧种子归一到 UTC 口径，
--    这里沿用同一口径，前端 fmtLocalDateTime 转本地后显示 08:00 而不是 16:00）。
-- ⚠️ 幂等：号源 id 为 slot-<doctorId>-<yyyymmdd>-<HHmm>，ON DUPLICATE KEY UPDATE 可重复执行；
--    不写 remaining=10 的覆盖式更新（第 ④ 步按有效预约数算），避免把已约的号"回血"超卖。
-- ⚠️ 仅 dev profile 加载（db/dev 只在 dev 的 flyway locations 里）。
-- =====================================================================

-- ---------- ① 补建未来 14 天 × 12 档 ----------
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
SELECT CONCAT('slot-', d.id, '-', DATE_FORMAT(day.dt, '%Y%m%d'), '-', t.suffix),
       d.id,
       TIMESTAMP(day.dt, t.start_hm) - INTERVAL 8 HOUR,
       TIMESTAMP(day.dt, t.end_hm) - INTERVAL 8 HOUR,
       10, 10, 25.00, 'CNY', 'OPEN'
FROM doctors d
CROSS JOIN (
    SELECT CURDATE() + INTERVAL n DAY AS dt
    FROM (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
          UNION SELECT 5 UNION SELECT 6 UNION SELECT 7 UNION SELECT 8 UNION SELECT 9
          UNION SELECT 10 UNION SELECT 11 UNION SELECT 12 UNION SELECT 13) nums
) day
CROSS JOIN (
              SELECT '08:00:00' AS start_hm, '08:30:00' AS end_hm, '0800' AS suffix
    UNION ALL SELECT '08:30:00', '09:00:00', '0830'
    UNION ALL SELECT '09:00:00', '09:30:00', '0900'
    UNION ALL SELECT '09:30:00', '10:00:00', '0930'
    UNION ALL SELECT '10:00:00', '10:30:00', '1000'
    UNION ALL SELECT '10:30:00', '11:00:00', '1030'
    UNION ALL SELECT '14:00:00', '14:30:00', '1400'
    UNION ALL SELECT '14:30:00', '15:00:00', '1430'
    UNION ALL SELECT '15:00:00', '15:30:00', '1500'
    UNION ALL SELECT '15:30:00', '16:00:00', '1530'
    UNION ALL SELECT '16:00:00', '16:30:00', '1600'
    UNION ALL SELECT '16:30:00', '17:00:00', '1630'
) t
WHERE d.status = 'ACTIVE'
ON DUPLICATE KEY UPDATE capacity = 10, status = 'OPEN', updated_at = CURRENT_TIMESTAMP(3);

-- ---------- ② 旧版每天两档（-am 09:00 / -pm 14:00）与 0900/1400 同刻重复 ----------
-- 只改 status 不删行：appointments.slot_id 有外键，历史预约仍要能关联到这条号源。
UPDATE doctor_slots
SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP(3)
WHERE status = 'OPEN'
  AND start_time >= NOW()
  AND (id LIKE '%-am' OR id LIKE '%-pm');

-- ---------- ③ 关闭过期号源（否则 hasAvailableSlot 会把已经过去的档算成"有号"）----------
UPDATE doctor_slots
SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP(3)
WHERE status = 'OPEN' AND start_time < NOW();

-- ---------- ④ 余号回补 = 容量 − 有效预约数（不无条件刷满，避免超卖）----------
UPDATE doctor_slots s
SET s.remaining = GREATEST(s.capacity - (
        SELECT COUNT(*) FROM appointments a
        WHERE a.slot_id = s.id AND a.status IN ('PENDING', 'CONFIRMED')), 0),
    s.updated_at = CURRENT_TIMESTAMP(3)
WHERE s.status = 'OPEN' AND s.start_time >= NOW();
