-- =====================================================================
-- V12__account_deletion_and_login_consent.sql —— N10 账号注销（软删）+ F7 登录同意版本（2026-10-19）
-- 事实源：docs/接口需求_待后端实现_20261019.md §三轮 N10/F7 + backend/contracts/business-openapi.yaml
-- 约定：注销为**软删**——status=DELETION_PENDING + 30 天冷静期时间戳，不物理删库；
--      冷静期到期后的物理清除由后续清理任务按 deletion_effective_at 执行（本批不实现清除任务）。
-- =====================================================================

ALTER TABLE users ADD COLUMN deletion_requested_at  DATETIME(3) NULL;
ALTER TABLE users ADD COLUMN deletion_effective_at  DATETIME(3) NULL;
-- F7：登录请求携带的隐私政策版本（users 级审计字段；不代表服务端替代独立同意界面）
ALTER TABLE users ADD COLUMN login_consent_version  VARCHAR(20) NULL;
