-- =====================================================================
-- test-m5-seed.sql —— 微信登录接入 + cursor 分页 E2E 专用种子（H2 MySQL 模式，仅测试 classpath）
--
-- 与 test-m1/m2/m3 seed 解耦：本文件只服务 M5 的两个测试类（微信登录集成 / cursor 分页 E2E），
-- 每个测试类各自使用独立 H2 库名，因此类内断言不受其他测试类的写操作影响。
--
-- 时间固定为 2099 年，规避"今日/未来"边界差异；断言只关心相对顺序与分页边界。
-- =====================================================================

-- ---------- 用户 ----------
-- u-dev-user-1：无医生任职（患者端登录基准；医生端 → 403）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-1', 'dev-user-1', NULL, NULL, 0, '开发用户甲', 'ACTIVE', 1, '2026-01-01 00:00:00');

-- u-dev-user-2：已登记医生任职（doc-gastro-1）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-2', 'dev-user-2', NULL, NULL, 0, '开发用户乙', 'ACTIVE', 1, '2026-01-01 00:00:00');

-- u-dev-user-3：已登记医生任职但**没有任何挂号**（空列表 + nextCursor=null 基准）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-3', 'dev-user-3', NULL, NULL, 0, '开发用户丙', 'ACTIVE', 1, '2026-01-01 00:00:00');

INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-1', 'u-dev-user-1', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-2', 'u-dev-user-2', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-3', 'u-dev-user-3', 1, '2026-01-01 00:00:00');

-- ---------- 科室 ----------
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-gastro', 'hosp-wechar-dev', '消化内科', '门诊楼 2F 东区', '消化道常见病', 'dept-gastro', 1, 'ACTIVE', '2026-01-01 00:00:00');

-- ---------- 医生 ----------
INSERT INTO doctors (id, department_id, user_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-gastro-1', 'dep-gastro', 'u-dev-user-2', '林建平', '主任医师', '["胃炎"]', '消化内科临床 25 年', 'ACTIVE', '2026-01-01 00:00:00');

-- doc-empty：绑定 u-dev-user-3，挂号表里没有任何记录
INSERT INTO doctors (id, department_id, user_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-empty', 'dep-gastro', 'u-dev-user-3', '苏雯', '副主任医师', '["功能性胃肠病"]', '功能性胃肠病调理', 'ACTIVE', '2026-01-01 00:00:00');

-- ---------- 号源 ----------
-- slot-m5-tie：三个挂号共用同一 start_time，用于验证 (start_time, id) 双键游标的稳定性
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m5-tie', 'doc-gastro-1', '2099-01-01 09:00:00', '2099-01-01 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m5-a', 'doc-gastro-1', '2099-01-02 09:00:00', '2099-01-02 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m5-b', 'doc-gastro-1', '2099-01-03 09:00:00', '2099-01-03 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m5-c', 'doc-gastro-1', '2099-01-04 09:00:00', '2099-01-04 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-m5-d', 'doc-gastro-1', '2099-01-05 09:00:00', '2099-01-05 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');

-- ---------- 挂号：共 7 条，期望顺序（start_time DESC, id DESC）----------
-- ap-m5-d(01-05) → ap-m5-c(01-04) → ap-m5-b(01-03) → ap-m5-a(01-02)
--   → 同时间组按 id DESC：ap-m5-t3 → ap-m5-t2 → ap-m5-t1
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-d', 'u-dev-user-1', NULL, 'slot-m5-d', 'doc-gastro-1', 'dep-gastro', '患者D',
        NULL, NULL, 'PENDING', 'seed-m5-key-d', 'seed-m5-digest-d', 1, '2026-01-01 00:00:00');
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-c', 'u-dev-user-1', NULL, 'slot-m5-c', 'doc-gastro-1', 'dep-gastro', '患者C',
        NULL, NULL, 'PENDING', 'seed-m5-key-c', 'seed-m5-digest-c', 1, '2026-01-01 00:00:00');
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-b', 'u-dev-user-1', NULL, 'slot-m5-b', 'doc-gastro-1', 'dep-gastro', '患者B',
        NULL, NULL, 'PENDING', 'seed-m5-key-b', 'seed-m5-digest-b', 1, '2026-01-01 00:00:00');
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-a', 'u-dev-user-1', NULL, 'slot-m5-a', 'doc-gastro-1', 'dep-gastro', '患者A',
        NULL, NULL, 'PENDING', 'seed-m5-key-a', 'seed-m5-digest-a', 1, '2026-01-01 00:00:00');
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-t3', 'u-dev-user-1', NULL, 'slot-m5-tie', 'doc-gastro-1', 'dep-gastro', '患者T3',
        NULL, NULL, 'PENDING', 'seed-m5-key-t3', 'seed-m5-digest-t3', 1, '2026-01-01 00:00:00');
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-t2', 'u-dev-user-1', NULL, 'slot-m5-tie', 'doc-gastro-1', 'dep-gastro', '患者T2',
        NULL, NULL, 'PENDING', 'seed-m5-key-t2', 'seed-m5-digest-t2', 1, '2026-01-01 00:00:00');
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-m5-t1', 'u-dev-user-1', NULL, 'slot-m5-tie', 'doc-gastro-1', 'dep-gastro', '患者T1',
        NULL, NULL, 'PENDING', 'seed-m5-key-t1', 'seed-m5-digest-t1', 1, '2026-01-01 00:00:00');
