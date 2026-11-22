-- =====================================================================
-- V9017__bind_doctor_accounts.sql —— 补齐 30 位医生的登录账号绑定（2026-11-22）
--
-- 背景：医生端 GET /api/v1/doctor/appointments 的数据范围由「任职关系」决定，
--       service 层判据是 doctors.user_id = 当前登录 user 且 doctors.status='ACTIVE'。
--       V9002 只把 doc-gastro-1（林建平）绑到 u-dev-user-2，其余 29 位医生 user_id 为 NULL，
--       患者即使挂了这些医生的号，医生端永远看不到（也没法登录医生端）。
--
-- 口径：
--   · 一位医生一个独立账号，不复用患者账号；openid 用 `dev-doc-<doctorId>`，
--     与 dev 档登录码 `dev-doctor-<doctorId>` 一一对应（见 DevWechatSessionProvider）。
--   · 不做手机号/密码绑定：dev 档没有密码体系，phone_cipher/phone_hash 留空、
--     phone_bound=0，避免伪造不可用的联系方式。
--   · 只补 user_id IS NULL 的医生，已绑定的（doc-gastro-1）不动。
--   · 幂等：INSERT IGNORE + UPDATE ... WHERE user_id IS NULL，重复执行无副作用。
--
-- 仅 dev profile 加载（application.yml dev 段追加 classpath:db/dev）。
-- 生产由院方 HR/账号系统预先登记，不跑本迁移。
-- =====================================================================

-- ① 为每位未绑定医生建独立登录账号（openid 与医生 ID 稳定对应）
INSERT IGNORE INTO users
    (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
SELECT CONCAT('u-doc-', d.id),
       CONCAT('dev-doc-', d.id),
       NULL,
       NULL,
       0,
       d.name,
       'ACTIVE',
       1,
       '2026-01-01 00:00:00'
FROM doctors d
WHERE d.user_id IS NULL;

-- ② 建账号后回填任职关系（只回填仍为空的，避免覆盖人工登记）
UPDATE doctors d
JOIN users u ON u.wechat_openid = CONCAT('dev-doc-', d.id)
SET d.user_id = u.id,
    d.updated_at = CURRENT_TIMESTAMP(3)
WHERE d.user_id IS NULL;

-- ③ 自检（人工执行，不参与迁移）：
--   SELECT COUNT(*) AS total,
--          SUM(user_id IS NOT NULL) AS bound
--   FROM doctors;                      -- 期望 30 / 30
