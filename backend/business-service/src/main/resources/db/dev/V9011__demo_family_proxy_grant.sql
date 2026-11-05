-- =====================================================================
-- V9011__demo_family_proxy_grant.sql —— V9010 演示家属授权修正（2026-11-05）
-- 仅 dev profile 加载（classpath:db/dev），不进入生产迁移。
--
-- 背景：V9010 已由 Flyway 应用（rank 38），其演示家属 fm-v9010-patient-a-child
--   的 proxy_status 写为 'NONE'，而 PatientService.requireProxyGranted 只允许
--   'GRANTED' —— 导致演示患者甲切换家庭成员时 /health-records 返回 404，
--   无法验收「切换家庭成员后只显示对应档案」。
-- 处置：按项目铁律「Flyway 只能版本递增追加」，不修改已应用的 V9010 checksum，
--   改用本迁移做单行、带 WHERE 守卫的幂等修正。
-- 安全：只命中本轮 V9010 新增的单个演示家属 ID，不碰任何原有家庭成员。
-- =====================================================================

UPDATE family_members
   SET proxy_status = 'GRANTED'
 WHERE id = 'fm-v9010-patient-a-child'
   AND user_id = 'u-v9010-patient-a'
   AND proxy_status = 'NONE';
