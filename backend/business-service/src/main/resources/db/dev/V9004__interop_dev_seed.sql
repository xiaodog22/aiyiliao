-- =====================================================================
-- V9004__interop_dev_seed.sql —— 医生-患者互通 dev 种子（2026-10-21）
-- ⚠️ 仅 dev profile 加载（application.yml 在 dev 追加 classpath:db/dev）。
-- 幂等：ON DUPLICATE KEY UPDATE / 定向 UPDATE，可重复执行。
-- 内容：
--   1) dev-user-1 演示消息 2 条（1 未读 + 1 已读）——消息中心/未读红点演示；
--   2) 1 条绑定 doc-gastro-1（= dev-user-2 的医生任职）的问诊会话，
--      末条为患者消息 → 医生端 /doctor/todos 的 CONSULT_REPLY 有可判定演示数据。
-- 红线：只写开发演示数据，不进入生产迁移。
-- =====================================================================

-- ---------- 1. 演示消息（患者侧消息中心） ----------
-- 医生工号补登（V11 列 dev 种子未写）：GET /doctor/me 的 employeeNo 演示值
UPDATE doctors SET employee_no = 'D0001', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'doc-gastro-1' AND (employee_no IS NULL OR employee_no = '');

INSERT INTO messages (id, user_id, type, title, body, ref_type, ref_id, read_at, created_at)
VALUES
  ('msg-dev-001', 'u-dev-user-1', 'APPOINTMENT_CREATED', '挂号成功',
   '您已预约 林建平 医生（消化内科）明日 09:00 的就诊号，请提前 15 分钟到院取号。',
   'appointment', 'ap-dev-demo-001', '2026-10-20 09:05:00.000', '2026-10-20 09:00:00.000'),
  ('msg-dev-002', 'u-dev-user-1', 'APPOINTMENT_STATUS', '医生已叫号',
   '林建平 医生已叫号，请前往 消化内科诊室（门诊楼 1F 东区）就诊。',
   'appointment', 'ap-dev-demo-001', NULL, '2026-10-20 10:30:00.000')
ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body), read_at = VALUES(read_at);

-- ---------- 2. 问诊会话（医生归属 + 待回复演示） ----------
INSERT INTO consultations (id, user_id, doctor_id, title, status, summary, last_message_at,
                           idempotency_key, request_digest, created_at)
VALUES ('cons-dev-001', 'u-dev-user-1', 'doc-gastro-1', '胃痛反酸咨询', 'ACTIVE',
        '饭后胃痛反酸一周，是否需要调整用药',
        '2026-10-20 14:05:00.000', 'dev-cons-001', NULL, '2026-10-20 14:00:00.000')
ON DUPLICATE KEY UPDATE doctor_id = VALUES(doctor_id), status = VALUES(status),
                        summary = VALUES(summary), last_message_at = VALUES(last_message_at);

INSERT INTO consultation_messages (id, consultation_id, user_id, role, content_type, content,
                                   provenance, created_at)
VALUES ('cmsg-dev-001', 'cons-dev-001', 'u-dev-user-1', 'user', 'TEXT',
        '最近吃完饭老是胃痛反酸，持续一周了，需要做什么检查吗？',
        'USER_INPUT', '2026-10-20 14:05:00.000')
ON DUPLICATE KEY UPDATE content = VALUES(content);
