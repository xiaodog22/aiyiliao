-- =====================================================================
-- test-m1-seed.sql —— M1 集成测试数据（H2 MySQL 模式，仅测试 classpath）
-- 与 dev 种子（V9000/V9001）解耦：测试只跑生产迁移（classpath:db/migration = V1+V2），
-- 数据由本文件在 Flyway 之后注入（spring.sql.init.data-locations）。
-- 时间用 2099/2000 固定值，规避"未来 7 天"边界；断言只关心相对关系。
-- =====================================================================

-- 用户：未绑定手机 + 已绑定手机（home 三分支）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-1', 'dev-user-1', NULL, NULL, 0, '开发用户甲', 'ACTIVE', 1, '2026-01-01 00:00:00');

INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-bound-user', 'dev-user-2', NULL, NULL, 1, '已绑手机用户', 'ACTIVE', 1, '2026-01-01 00:00:00');

-- 已绑定但无预约（home AI_GUIDANCE 分支）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-bound-empty', 'dev-user-3', NULL, NULL, 1, '已绑无预约用户', 'ACTIVE', 1, '2026-01-01 00:00:00');

INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-1', 'u-dev-user-1', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-bound-user', 'u-bound-user', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-bound-empty', 'u-bound-empty', 1, '2026-01-01 00:00:00');

-- 科室（与 dev 种子同名，供 triage 关键词映射落库）
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-gastro', 'hosp-wechar-dev', '消化内科', '门诊楼 2F 东区', '消化道常见病', 'dept-gastro', 1, 'ACTIVE', '2026-01-01 00:00:00');
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-resp', 'hosp-wechar-dev', '呼吸内科', '门诊楼 3F 西区', '呼吸系统常见病', 'dept-resp', 2, 'ACTIVE', '2026-01-01 00:00:00');
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-cardio', 'hosp-wechar-dev', '心血管内科', '门诊楼 4F 东区', '心血管疾病随访', 'dept-cardio', 3, 'ACTIVE', '2026-01-01 00:00:00');
INSERT INTO departments (id, hospital_id, name, location, description, icon_key, sort_order, status, created_at)
VALUES ('dep-ortho', 'hosp-wechar-dev', '骨科', '门诊楼 1F 西区', '颈肩腰腿痛', 'dept-ortho', 4, 'ACTIVE', '2026-01-01 00:00:00');

-- 医生
INSERT INTO doctors (id, department_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-gastro-1', 'dep-gastro', '林建平', '主任医师', '["胃炎","消化性溃疡"]', '消化内科临床 25 年', 'ACTIVE', '2026-01-01 00:00:00');
INSERT INTO doctors (id, department_id, name, title, specialties_json, introduction, status, created_at)
VALUES ('doc-resp-1', 'dep-resp', '陈志远', '主任医师', '["慢性咳嗽","哮喘"]', '呼吸内科临床 22 年', 'ACTIVE', '2026-01-01 00:00:00');

-- 号源：未来可约（remaining 5）
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-future-1', 'doc-gastro-1', '2099-01-01 09:00:00', '2099-01-01 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');

-- 号源：已满（remaining 0）
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-full-1', 'doc-gastro-1', '2099-01-02 09:00:00', '2099-01-02 09:30:00', 5, 0, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');

-- 号源：过去时段
INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status, created_at)
VALUES ('slot-past-1', 'doc-gastro-1', '2000-01-01 09:00:00', '2000-01-01 09:30:00', 5, 5, 25.00, 'CNY', 'OPEN', '2026-01-01 00:00:00');

-- 已绑定用户的未来预约（home UPCING_APPOINTMENT 分支 + stats）
INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, patient_name,
                          contact_phone_cipher, symptom_summary, status, idempotency_key, request_digest,
                          version, created_at)
VALUES ('ap-bound-1', 'u-bound-user', NULL, 'slot-future-1', 'doc-gastro-1', 'dep-gastro', '张三',
        NULL, NULL, 'PENDING', 'seed-key-000001', 'seed-digest', 1, '2026-01-01 00:00:00');

-- 号源 1 被种子预约占用一席
UPDATE doctor_slots SET remaining = 4 WHERE id = 'slot-future-1';

-- 内容（APPROVED + 有效期覆盖今天；DRAFT 演示不可见）
INSERT INTO contents (id, title, summary, category, body, source, reviewer, cover_key, review_status,
                      provenance, effective_from, effective_to, published_at, read_count, created_at)
VALUES ('cont-test-1', '测试科普标题', '测试摘要', '呼吸养护', '测试正文', '测试来源', '测试审核', NULL,
        'APPROVED', 'HUMAN_REVIEWED', '2026-01-01', '2099-12-31', '2026-10-01 02:00:00', 10, '2026-01-01 00:00:00');

INSERT INTO contents (id, title, summary, category, body, source, reviewer, cover_key, review_status,
                      provenance, effective_from, effective_to, published_at, read_count, created_at)
VALUES ('cont-test-draft', '草稿标题', NULL, '演示', '草稿正文', NULL, NULL, NULL,
        'DRAFT', 'HUMAN_REVIEWED', NULL, NULL, NULL, 0, '2026-01-01 00:00:00');
