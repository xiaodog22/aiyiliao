-- =====================================================================
-- V9022__easter_egg_patient_login.sql —— 彩蛋患者「陈楷楠」小程序登录身份（2026-11-22）
--
-- 背景：HIS P000099 / 陈楷楠只是院内档案，没有登录体系；小程序的手机号登录
--       13800138000 原本落到 dev-user-1（张三），与患者本人不一致。
-- 做法：为本机 dev 演示建一个独立患者账号，openid = dev-user-chen-13800138000，
--       并通过 APP_AUTH_DEV_LOGIN_IDENTITY_MAP 把手机号显式映射到它。
-- 口径：仅 dev 档演示身份，不是微信真实凭证；不绑定真实手机号密文（phone_bound=0）。
-- 幂等：INSERT IGNORE；不覆盖已有资料。
-- =====================================================================

INSERT IGNORE INTO users (id, wechat_openid, phone_bound, display_name, status, version, created_at)
VALUES ('u-easter-egg-chen', 'dev-user-chen-13800138000', 0, '陈楷楠', 'ACTIVE', 1, CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO user_profiles (id, user_id, birth_date, sex, version, created_at)
VALUES ('up-easter-egg-chen', 'u-easter-egg-chen', '2006-05-20', '女', 1, CURRENT_TIMESTAMP(3));

INSERT IGNORE INTO user_extended (id, user_id, residence, version, created_at)
VALUES ('ue-easter-egg-chen', 'u-easter-egg-chen', '广州市天河区石牌街道', 1, CURRENT_TIMESTAMP(3));
