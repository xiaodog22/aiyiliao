-- =====================================================================
-- test-m2-seed.sql —— M2 集成测试数据（H2 MySQL 模式，仅测试 classpath）
-- 与 test-m1-seed.sql 解耦：测试只跑生产迁移（classpath:db/migration = V1~V4），
-- 数据由本文件在 Flyway 之后注入（spring.sql.init.data-locations）。
-- 时间用 2099/2000 固定值，规避"未来 7 天"边界；断言只关心相对关系。
-- =====================================================================

-- 用户（M2 各域共用）
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-1', 'dev-user-1', NULL, NULL, 0, '开发用户甲', 'ACTIVE', 1, '2026-01-01 00:00:00');

INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-2', 'dev-user-2', NULL, NULL, 0, '开发用户乙', 'ACTIVE', 1, '2026-01-01 00:00:00');

INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-1', 'u-dev-user-1', 1, '2026-01-01 00:00:00');
INSERT INTO user_profiles (id, user_id, version, created_at) VALUES ('up-u-dev-user-2', 'u-dev-user-2', 1, '2026-01-01 00:00:00');

-- 已存在的问诊会话（X-User-Id=dev-user-1 归属验证用；他人资源一律 404）
INSERT INTO consultations (id, user_id, title, status, summary, last_message_at, idempotency_key,
                           request_digest, created_at, updated_at)
VALUES ('cn-seed-1', 'u-dev-user-1', '种子会话', 'ACTIVE', NULL, '2026-01-01 00:00:00',
        'seed-m2-consult-0001', 'seed-digest', '2026-01-01 00:00:00', '2026-01-01 00:00:00');

-- 该会话下的转写草稿（confirmations 的 DRAFT → CONFIRMED 链路；sourceTaskId 用会话内任务）
INSERT INTO consultation_messages (id, consultation_id, user_id, role, content_type, content, provenance,
                                   citations_json, risk_tags_json, generation_status, source_task_id,
                                   idempotency_key, request_digest, confirm_idempotency_key, confirm_digest,
                                   created_at)
VALUES ('msg-draft-1', 'cn-seed-1', 'u-dev-user-1', 'user', 'VOICE_TRANSCRIPT', '胃胀三天了',
        'USER_INPUT', NULL, NULL, 'DRAFT', 'task-seed-asr-1', NULL, NULL, NULL, NULL,
        '2026-01-01 00:00:01');
