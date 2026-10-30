-- =====================================================================
-- test-m3-seed.sql —— M3 集成测试数据（H2 MySQL 模式，仅测试 classpath）
-- 与 test-m1/m2-seed.sql 解耦：测试只跑生产迁移（classpath:db/migration = V1~V5），
-- 数据由本文件在 Flyway 之后注入（spring.sql.init.data-locations）。
-- 时间用 2099/2000 固定值，规避"今日/未来"边界；断言只关心相对关系。
-- =====================================================================

-- ---------- 用户 ----------
-- u-dev-user-1：无医生任职（用 X-User-Id=dev-user-1 验证医生端 403）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-1', 'dev-user-1', NULL, NULL, 0, '开发用户甲', 'ACTIVE', 1, '2026-01-01 00:00:00');

-- u-dev-user-2：已登记医生任职（doc-gastro-1 绑定）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-2', 'dev-user-2', NULL, NULL, 0, '开发用户乙', 'ACTIVE', 1, '2026-01-01 00:00:00');

-- u-m3-patient：入床 patientRef 用的内部患者 ID（2 字名用于验证脱敏）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-m3-patient', 'm3-patient', NULL, NULL, 1, '张三', 'ACTIVE', 1, '2026-01-01 00:00:00');

INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-1', 'u-dev-user-1', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-2', 'u-dev-user-2', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-m3-patient', 'u-m3-patient', 1, '2026-01-01 00:00:00');

-- ---------- 科室 ----------
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-gastro', 'hosp-wechar-dev', '消化内科', '门诊楼 2F 东区', '消化道常见病', 'dept-gastro', 1, 'ACTIVE', '2026-01-01 00:00:00');
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-resp', 'hosp-wechar-dev', '呼吸内科', '门诊楼 3F 西区', '呼吸系统常见病', 'dept-resp', 2, 'ACTIVE', '2026-01-01 00:00:00');

-- ---------- 医生 ----------
-- doc-gastro-1 绑定 u-dev-user-2（医生端登录/工作台/范围裁剪的基准）
INSERT INTO doctors (id, department_id, user_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-gastro-1', 'dep-gastro', 'u-dev-user-2', '林建平', '主任医师', '["胃炎"]', '消化内科临床 25 年', 'ACTIVE', '2026-01-01 00:00:00');

-- doc-gastro-2 未绑定任何账号（仅用于确认"未绑定 ≠ 可登录"）
INSERT INTO doctors (id, department_id, user_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-gastro-2', 'dep-gastro', NULL, '苏雯', '副主任医师', '["功能性胃肠病"]', '功能性胃肠病调理', 'ACTIVE', '2026-01-01 00:00:00');

-- doc-resp-1 属呼吸内科：其挂号对消化内科医生不可见（范围隔离）
INSERT INTO doctors (id, department_id, user_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-resp-1', 'dep-resp', NULL, '陈志远', '主任医师', '["慢性咳嗽"]', '呼吸内科临床 22 年', 'ACTIVE', '2026-01-01 00:00:00');

-- ---------- 病区 ----------
INSERT INTO wards (id, department_id, name, status, created_at)
VALUES ('ward-gastro-a', 'dep-gastro', '消化内科一病区', 'ACTIVE', '2026-01-01 00:00:00');
-- 同科室第二病区（workbench scope.wardIds 多值断言；其床位不被任何测试改动）
INSERT INTO wards (id, department_id, name, status, created_at)
VALUES ('ward-gastro-b', 'dep-gastro', '消化内科二病区', 'ACTIVE', '2026-01-01 00:00:00');
INSERT INTO wards (id, department_id, name, status, created_at)
VALUES ('ward-resp-a', 'dep-resp', '呼吸内科一病区', 'ACTIVE', '2026-01-01 00:00:00');

-- ---------- 床位 ----------
-- AVAILABLE（可分配；ASSIGN 目标）
INSERT INTO beds (id, ward_id, label, status, occupant_user_id, occupant_display_name, admitted_at, version, created_at)
VALUES ('bed-gastro-a-01', 'ward-gastro-a', 'A-01', 'AVAILABLE', NULL, NULL, NULL, 1, '2026-01-01 00:00:00');
-- 已被占用（version=3：验证 expectedVersion 不匹配 → 409）
INSERT INTO beds (id, ward_id, label, status, occupant_user_id, occupant_display_name, admitted_at, version, created_at)
VALUES ('bed-gastro-a-02', 'ward-gastro-a', 'A-02', 'OCCUPIED', 'u-m3-patient', '张*', '2026-01-02 01:00:00', 3, '2026-01-01 00:00:00');
-- 呼吸内科病区（对消化内科医生越权：病区过滤 → 403 / 直接分配 → 404）
INSERT INTO beds (id, ward_id, label, status, occupant_user_id, occupant_display_name, admitted_at, version, created_at)
VALUES ('bed-resp-a-01', 'ward-resp-a', 'R-01', 'AVAILABLE', NULL, NULL, NULL, 1, '2026-01-01 00:00:00');
-- AVAILABLE（RESERVE 目标）
INSERT INTO beds (id, ward_id, label, status, occupant_user_id, occupant_display_name, admitted_at, version, created_at)
VALUES ('bed-gastro-a-04', 'ward-gastro-a', 'A-04', 'AVAILABLE', NULL, NULL, NULL, 1, '2026-01-01 00:00:00');
-- 第二病区床位（不被任何测试改动，保证 availableBeds ≥ 1 与列表长度稳定）
INSERT INTO beds (id, ward_id, label, status, occupant_user_id, occupant_display_name, admitted_at, version, created_at)
VALUES ('bed-gastro-b-01', 'ward-gastro-b', 'B-01', 'AVAILABLE', NULL, NULL, NULL, 1, '2026-01-01 00:00:00');

-- ---------- 号源 ----------
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m3-1', 'doc-gastro-1', '2099-01-01 09:00:00', '2099-01-01 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m3-2', 'doc-resp-1', '2099-01-01 09:00:00', '2099-01-01 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');

-- ---------- 挂号 ----------
-- 本医生、PENDING、version=1（状态流转正常路径 + 乐观锁冲突路径）
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m3-1', 'u-dev-user-1', NULL, 'slot-m3-1', 'doc-gastro-1', 'dep-gastro', '张三',
        NULL, NULL, 'PENDING', 'seed-m3-key-0001', 'seed-digest-1', 1, '2026-01-01 00:00:00');

-- 本医生、PENDING、version=1（乐观锁冲突 / 未知枚举 422 用；不做成功流转）
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m3-2', 'u-dev-user-1', NULL, 'slot-m3-1', 'doc-gastro-1', 'dep-gastro', '赵六',
        NULL, NULL, 'PENDING', 'seed-m3-key-0004', 'seed-digest-4', 1, '2026-01-01 00:00:00');

-- 本医生、PENDING、version=1（乐观锁冲突专用；不被其他测试改动）
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m3-3', 'u-dev-user-1', NULL, 'slot-m3-1', 'doc-gastro-1', 'dep-gastro', '孙七',
        NULL, NULL, 'PENDING', 'seed-m3-key-0005', 'seed-digest-5', 1, '2026-01-01 00:00:00');

-- 本医生、已终态 COMPLETED（非法流转 → 409）
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m3-done', 'u-dev-user-1', NULL, 'slot-m3-1', 'doc-gastro-1', 'dep-gastro', '李四',
        NULL, NULL, 'COMPLETED', 'seed-m3-key-0002', 'seed-digest-2', 2, '2026-01-01 00:00:00');

-- 他科医生（消化内科医生访问 → 404，不泄露存在性）
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m3-resp', 'u-dev-user-1', NULL, 'slot-m3-2', 'doc-resp-1', 'dep-resp', '王五',
        NULL, NULL, 'PENDING', 'seed-m3-key-0003', 'seed-digest-3', 1, '2026-01-01 00:00:00');

-- ---------- 同意记录（list/withdraw 基准；不含幂等列 → idempotency_key 为 NULL） ----------
INSERT INTO consents (id, user_id, purpose, policy_version, status, channel, scope_json, evidence_digest, created_at)
VALUES ('cs-seed-1', 'u-dev-user-1', 'PRIVACY_POLICY', 'v1.0', 'GRANTED', 'MINIPROGRAM', '["basic"]', NULL, '2026-01-01 00:00:00');
-- 撤回测试专用（列表断言不触碰该 purpose，避免测试间顺序耦合）
INSERT INTO consents (id, user_id, purpose, policy_version, status, channel, scope_json, evidence_digest, created_at)
VALUES ('cs-seed-2', 'u-dev-user-1', 'HEALTH_DATA_PROCESSING', 'v1.0', 'GRANTED', 'MINIPROGRAM', NULL, NULL, '2026-01-01 00:00:00');
