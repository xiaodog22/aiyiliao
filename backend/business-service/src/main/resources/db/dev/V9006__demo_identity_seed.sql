-- =====================================================================
-- V9006__demo_identity_seed.sql —— 演示身份真实化 dev 种子（2026-10-24）
-- ⚠️ 仅 dev profile 加载（application.yml 在 dev 追加 classpath:db/dev）；不进入生产迁移。
-- ⚠️ Flyway 已应用的 V9000~V9005 禁止改动（checksum），本文件为**新增**增量迁移。
-- 幂等：INSERT ... ON DUPLICATE KEY UPDATE / 纯 UPDATE，可重复执行不报错。
--
-- 用户要求：
--   1) 演示不出现「开发用户甲/乙」字样，姓名真实化：
--      - u-dev-user-1（患者一键登录 dev-user-1）→ 张三（13800138001 演示）
--      - u-dev-user-2（医生端 dev-user-2-manual-13900139001 → openid=dev-user-2）→ 林建平
--   2) 医生登录消息与患者挂号消息对应：
--      - V9004 已有患者侧消息（msg-dev-001/002，正文写「林建平 消化内科」）
--        与 cons-dev-001（胃痛反酸，患者末条待回复）；
--      - 本文件给 u-dev-user-2（林建平）补 CONSULT_APPLY 申请通知，
--        使医生端消息中心红点与患者申请一一对应（refType=consultation → 直达会话）。
--   3) phone_cipher 不预生成（加密密钥在运行时 env），演示时可在「账号安全」页
--      dev 直传绑定；本种子只落 display_name 与消息对应关系。
-- =====================================================================

-- ---------- 1. 患者身份真实化：张三 ----------
-- u-dev-user-1 由运行时自动建档（openid=dev-user-1），这里补建/更正 display_name。
INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-1', 'dev-user-1', NULL, NULL, 0, '张三', 'ACTIVE', 1, '2026-01-01 00:00:00')
ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), status = 'ACTIVE';

INSERT INTO user_profiles (id, user_id, version, created_at)
VALUES ('up-u-dev-user-1', 'u-dev-user-1', 1, '2026-01-01 00:00:00')
ON DUPLICATE KEY UPDATE updated_at = CURRENT_TIMESTAMP(3);

-- ---------- 2. 医生身份真实化：林建平（替换「开发用户乙」） ----------
UPDATE users SET display_name = '林建平', status = 'ACTIVE', updated_at = CURRENT_TIMESTAMP(3)
WHERE id = 'u-dev-user-2' AND wechat_openid = 'dev-user-2';

-- doc-gastro-1（消化内科 主任医师）任职绑定已在 V9002：doctors.user_id='u-dev-user-2'，无需重复。

-- ---------- 3. 医生端消息：患者张三的在线问诊申请通知（CONSULT_APPLY） ----------
-- 对应 cons-dev-001（V9004：患者张三「胃痛反酸咨询」，末条 user 消息待回复）。
-- 医生端消息中心 unread-count → 红点；点击该条 refType=consultation → 直达会话回复。
INSERT INTO messages (id, user_id, type, title, body, ref_type, ref_id, read_at, created_at)
VALUES ('msg-doc-apply-001', 'u-dev-user-2', 'CONSULT_APPLY', '患者在线问诊申请',
        '患者 张三（138****0001）发起在线问诊「胃痛反酸咨询」，请尽快接诊并回复。',
        'consultation', 'cons-dev-001', NULL, '2026-10-20 14:06:00.000')
ON DUPLICATE KEY UPDATE title = VALUES(title), body = VALUES(body),
                        ref_type = VALUES(ref_type), ref_id = VALUES(ref_id), read_at = NULL;

-- ---------- 4. 患者侧消息正文姓名对齐（保险：若历史行姓名残留，不做强行改写，仅保证新数据） ----------
-- V9004 的 msg-dev-001/002 正文已写「林建平 医生」，无需变更。
