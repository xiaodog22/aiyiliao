-- H2 单测专用补丁：审计 H2 / M12（生产 V32）的 H2 等价物。
--
-- 生产 V32 含 MySQL 语法 ADD KEY，且 H2 档 Flyway target 锁在 26.x，不会执行 V32。
-- 若不补列，SMS 挑战插入 phone_hash_legacy、会话插入 parent_session_id 都会
-- 「Column not found」500。语义与生产 V32 完全一致，仅存在于测试 classpath。
ALTER TABLE sms_challenges ADD COLUMN phone_hash_legacy CHAR(64) NULL;

ALTER TABLE auth_sessions ADD COLUMN parent_session_id VARCHAR(64) NULL;

CREATE INDEX idx_auth_sessions_parent ON auth_sessions (parent_session_id);
