-- PERF-06（2026-11-01）：auth_sessions 过期清理的支撑索引。
--
-- 背景：新增 AuthSessionCleanupTask 每日按 refresh_expires_at 范围删除过期会话行，
-- 而 V3 建表时只有 user_id / 两个 token hash 的索引，refresh_expires_at 无索引 →
-- 清理语句必然全表扫描。表当前仅 369 行（扫描无感），但会话是随登录量线性增长的，
-- 不清就会一直涨；一旦上量，每日全表 DELETE 的锁范围与扫描成本都会放大。
--
-- 判据口径：按 refresh_expires_at（不是 access_expires_at）—— access 过期后 refresh 仍可轮换，
-- 提前删会让用户在 7 天续期窗口内被强制登出；refresh 过期才代表整条会话彻底无用。

CREATE INDEX idx_auth_sessions_refresh_expires ON auth_sessions (refresh_expires_at);
