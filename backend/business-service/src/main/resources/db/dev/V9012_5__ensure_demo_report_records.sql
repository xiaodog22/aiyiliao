-- =====================================================================
-- V9012_5__ensure_demo_report_records.sql —— 全新 dev 库的报告主记录前置（2026-11-23，L3 实测）
--
-- 背景：V9013 的 health_report_details 引用 hr-demo-exam-cbc / -ct / -annual，
--       但这三条 health_records 从未在任何迁移中创建（存量库由历史手工数据掩盖）。
--       全新库执行 V9013 时 FK fk_hrd_record_user 1452 失败。
-- 处理：在 V9013 之前幂等补建三条 READY 报告主记录；V9013 继续补明细/分组/项目。
-- 影响：仅 dev profile；不改既有迁移 checksum，生产顺序不变。
-- =====================================================================

INSERT INTO health_records (id, user_id, family_member_id, category, title, summary, recorded_at,
                            source, doctor_name, abnormal, report_status, hospital, version,
                            idempotency_key, request_digest, created_at)
VALUES
  ('hr-demo-exam-cbc', 'u-dev-user-1', NULL, 'EXAM', '血常规检验报告（演示）',
   '演示报告摘要：血常规检验报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据',
   '2026-10-20 09:20:00.000', 'DEMO_SEED_V9013', '演示医师（模拟）', 0, 'READY',
   '演示医学检验中心（模拟）', 1, NULL, NULL, '2026-10-20 09:20:00.000'),
  ('hr-demo-exam-ct', 'u-dev-user-1', NULL, 'EXAM', '胸部 CT 平扫报告（演示）',
   '演示报告摘要：胸部 CT 平扫报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据',
   '2026-10-25 15:40:00.000', 'DEMO_SEED_V9013', '演示医师（模拟）', 0, 'READY',
   '演示影像诊断中心（模拟）', 1, NULL, NULL, '2026-10-25 15:40:00.000'),
  ('hr-demo-exam-annual', 'u-dev-user-1', NULL, 'EXAM', '年度健康体检报告（演示）',
   '演示报告摘要：年度健康体检报告（演示）。演示数据 · 非真实医疗报告 · 不构成诊断依据',
   '2026-10-28 08:30:00.000', 'DEMO_SEED_V9013', '演示医师（模拟）', 0, 'READY',
   '演示健康体检中心（模拟）', 1, NULL, NULL, '2026-10-28 08:30:00.000')
ON DUPLICATE KEY UPDATE id = VALUES(id);
