-- =====================================================================
-- V9002__m3_dev_seed.sql —— M3 dev 种子（医生任职绑定 + 病区 + 床位）
-- ⚠️ 仅 dev profile 加载：application.yml 的 spring.flyway.locations 在 dev 下追加 classpath:db/dev，
--    生产（非 dev）只有 classpath:db/migration，本文件不会进入生产迁移。
-- 幂等：ON DUPLICATE KEY UPDATE / 纯 UPDATE，可重复执行不报错。
-- 说明：
--   1) 医生端登录要求"院方预先登记"——dev 档把 doc-gastro-1（林建平）绑定到 dev 用户 u-dev-user-2，
--      使"code 含 dev-user-2"的医生登录可以真实命中任职关系（DevWechatSessionProvider 见 auth 包）。
--   2) 病区→科室、床位→病区：医生授权病区由其科室推导（契约 workbench scope.wardIds）。
--   3) occupant_display_name 存**已脱敏**展示名，dev 种子同样脱敏（不在床位表落明文姓名）。
-- =====================================================================

-- ---------- dev 账号（供医生任职绑定；与登录自动建档的结果一致） ----------
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-2', 'dev-user-2', NULL, NULL, 0, '开发用户乙', 'ACTIVE', 1, '2026-01-01 00:00:00')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name);

INSERT INTO user_profiles (id, user_id, version, created_at)
VALUES ('up-u-dev-user-2', 'u-dev-user-2', 1, '2026-01-01 00:00:00')
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 医生任职绑定 ----------
UPDATE doctors SET user_id = 'u-dev-user-2', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'doc-gastro-1' AND status = 'ACTIVE';

-- ---------- 病区（消化内科 2 个 + 呼吸内科 1 个，用于验证跨科室范围隔离） ----------
INSERT INTO wards (id, department_id, name, status)
VALUES
  ('ward-gastro-a', 'dep-gastro', '消化内科一病区', 'ACTIVE'),
  ('ward-gastro-b', 'dep-gastro', '消化内科二病区', 'ACTIVE'),
  ('ward-resp-a',   'dep-resp',   '呼吸内科一病区', 'ACTIVE')
ON DUPLICATE KEY UPDATE name = VALUES(name), updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 床位 ----------
INSERT INTO beds (id, ward_id, label, status, occupant_user_id, occupant_display_name, admitted_at, version)
VALUES
  ('bed-gastro-a-01', 'ward-gastro-a', 'A-01', 'AVAILABLE', NULL, NULL, NULL, 1),
  ('bed-gastro-a-02', 'ward-gastro-a', 'A-02', 'OCCUPIED',  'u-dev-user-1', '开*', '2026-10-14 01:00:00.000', 1),
  ('bed-gastro-a-03', 'ward-gastro-a', 'A-03', 'CLEANING',  NULL, NULL, NULL, 1),
  ('bed-gastro-b-01', 'ward-gastro-b', 'B-01', 'AVAILABLE', NULL, NULL, NULL, 1),
  ('bed-resp-a-01',   'ward-resp-a',   'R-01', 'AVAILABLE', NULL, NULL, NULL, 1)
ON DUPLICATE KEY UPDATE status = VALUES(status), occupant_user_id = VALUES(occupant_user_id),
                        occupant_display_name = VALUES(occupant_display_name),
                        admitted_at = VALUES(admitted_at), updated_at = CURRENT_TIMESTAMP(3);
