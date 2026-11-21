-- H2 单测专用补丁：P0-3（生产 V33）的 H2 等价物。
--
-- 生产 V33 含 MySQL 语法（多列 ALTER / UNIQUE KEY），且 H2 档 Flyway target 锁在 26.x，
-- 不会执行 V33。消息幂等写入依赖 biz_key / uq_messages_user_biz，若不补列，
-- MessageService.notifyOnce 会「Column not found」500。
--
-- 隔离边界：报告投影列只服务 MySQL 报告读模型；H2 档本就没有 V27 报告表（target=26），
-- 故本文件只补 messages 部分，语义与生产 V33 中 messages 段落完全一致。
ALTER TABLE messages ADD COLUMN biz_key VARCHAR(128) NULL;

CREATE UNIQUE INDEX uq_messages_user_biz ON messages (user_id, biz_key);
