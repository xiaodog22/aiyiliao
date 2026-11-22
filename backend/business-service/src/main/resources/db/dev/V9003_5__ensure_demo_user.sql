-- =====================================================================
-- V9003_5__ensure_demo_user.sql —— 全新 dev 库的演示用户前置（2026-11-23，L3 实测发现）
--
-- 背景：V9004 的消息/会话外键引用 u-dev-user-1，但该用户原本由 V9006 或运行时建档；
--       存量 dev 库因运行时早已创建而未暴露；全新库执行到 V9004 直接 FK 1452 失败。
-- 处理：在 V9004 之前幂等补建演示患者（仅 id/openid/display_name，不写手机号密文），
--       V9006 仍负责后续身份真实化（display_name=张三）与 profile 补齐。
-- 影响：仅 dev profile（db/dev）；生产迁移顺序不变，checksum 不改动既有 V9000~V9006。
-- =====================================================================

INSERT INTO users (id, wechat_openid, phone_cipher, phone_hash, phone_bound, display_name, status, version, created_at)
VALUES ('u-dev-user-1', 'dev-user-1', NULL, NULL, 0, '演示患者', 'ACTIVE', 1, '2026-01-01 00:00:00')
ON DUPLICATE KEY UPDATE id = VALUES(id);
