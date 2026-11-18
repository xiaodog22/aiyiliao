-- V32__security_h2_m12.sql
-- 审计 H2：短信挑战保留旧 SHA-256 摘要，支持 HMAC 双读迁移。
-- 新行 phone_hash = HMAC-SHA256(APP_PHONE_HMAC_KEY, phone)；
-- phone_hash_legacy = SHA-256(phone)（只用于比对历史 users.phone_hash，禁止作为新写入）。
ALTER TABLE sms_challenges
    ADD COLUMN phone_hash_legacy CHAR(64) NULL AFTER phone_hash;

-- 审计 M12：会话链拓扑。parent_session_id 指向签发该会话的上一会话，
-- /auth/session 只能派生受上限约束的子会话，不能无限扩张独立会话链。
ALTER TABLE auth_sessions
    ADD COLUMN parent_session_id VARCHAR(64) NULL AFTER id,
    ADD KEY idx_auth_sessions_parent (parent_session_id);
