-- =====================================================================
-- V9012__seed_timezone_normalize.sql —— 修正 dev 种子时间的时区口径（2026-11-12）
--
-- 缺陷 DEF-02 / DEF-17 的数据侧根因：
--   JDBC 连接串是 connectionTimeZone=UTC&forceConnectionTimeZoneToSession=true
--   （见 application.yml），session 时区被强制成 UTC。种子 SQL 却直接写
--   TIMESTAMP(day, '09:00:00')，本意是「北京时间 09:00」—— 结果被当成 UTC 09:00 存下，
--   读出来的 Instant 是 09:00Z（= 北京 17:00）。
--
--   同时前端还各自解析：挂号页截字符串（不转时区）→ 显示 09:00，
--   医生端走 fmtLocalDateTime（转本地）→ 显示 17:00。**数据错一次 + 前端不转一次，互相掩盖**。
--
-- 本迁移只做一件事：把「本意是北京时间、却被当 UTC 存」的**演示数据**改写成真正的 UTC。
-- 前端在同一批改为统一按设备本地时区展示（services/appointment.js + reports 两页），
-- 所以修完之后屏幕上仍然是「09:00 / 15:30」，而不是偏 8 小时。
--
-- ⚠️ 边界（刻意保守）：
--   1. 只碰**演示种子**：doctor_slots 仅匹配种子 id 形状（slot-<doctorId>-<yyyymmdd>-am|pm）
--      且小时恰为 9/14；健康档案/报告仅匹配 source='DEMO_SEED_V9010' / is_demo=1。
--      真实用户数据一条不动。
--   2. 幂等保护：改完后小时变成 1/6，再次执行不会二次平移（WHERE 不再命中）。
--   3. 只对 dev 生效（db/dev 目录仅在 dev profile 的 flyway locations 里）。
-- =====================================================================

-- ---------- ① 号源：北京 09:00 / 14:00 → UTC 01:00 / 06:00 ----------
UPDATE doctor_slots
SET start_time = start_time - INTERVAL 8 HOUR,
    end_time   = end_time   - INTERVAL 8 HOUR,
    updated_at = CURRENT_TIMESTAMP(3)
WHERE id LIKE 'slot-%'
  AND MINUTE(start_time) = 0
  AND (HOUR(start_time) = 9 OR HOUR(start_time) = 14);

-- ---------- ② 健康档案时间（recorded_at）----------
-- 不含「只显示日期」的语义变化：fmtDate 走 Date 解析后按设备本地取值，平移后仍显示原日期。
UPDATE health_records
SET recorded_at = recorded_at - INTERVAL 8 HOUR
WHERE source = 'DEMO_SEED_V9010'
  AND recorded_at IS NOT NULL;

-- ---------- ③ 报告明细的四个时间点 ----------
UPDATE health_report_details
SET collection_at = collection_at - INTERVAL 8 HOUR
WHERE is_demo = 1 AND collection_at IS NOT NULL;

UPDATE health_report_details
SET received_at = received_at - INTERVAL 8 HOUR
WHERE is_demo = 1 AND received_at IS NOT NULL;

UPDATE health_report_details
SET tested_at = tested_at - INTERVAL 8 HOUR
WHERE is_demo = 1 AND tested_at IS NOT NULL;

UPDATE health_report_details
SET reported_at = reported_at - INTERVAL 8 HOUR
WHERE is_demo = 1 AND reported_at IS NOT NULL;

-- ---------- ④ 平移后落到过去的 OPEN 号源 → 置 CLOSED ----------
-- 平移把「北京 09:00 被存成 09:00Z（= 北京 17:00）」改成真正的 01:00Z（= 北京 09:00），
-- 于是原本"看起来还在未来"的号源可能已经过去。V9008 的收尾只在它自己执行时跑过一次，
-- 这里补一次，保持「过期号源一律 CLOSED」的演示数据口径（否则列表里会出现约不上的空号）。
-- NOW() 比较与存储同口径（会话时区被强制为 UTC），不会二次偏移。
UPDATE doctor_slots
SET status = 'CLOSED', updated_at = CURRENT_TIMESTAMP(3)
WHERE status = 'OPEN' AND start_time < NOW();
