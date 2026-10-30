-- =====================================================================
-- V19__health_articles_video_key.sql —— 科普文章视频对象键（阶段二，2026-10-20）
--
-- 与 cover_key 同构：都指向 AttachmentStorage 的对象键（32hex + 扩展名），
-- 响应内的 URL 由服务端生成 HMAC 短期签名，**不存二进制、不存 URL**。
--
-- 为什么单独一列而不是复用 cover_key：封面是图片（15 分钟 TTL），
-- 视频需要 2 小时 TTL（覆盖停留+播放+拖动），且前端走 <video> 而非 <image>。
--
-- 只加列，不建 dev 种子（health_articles 现有 0 行；测试数据放 H2 测试与
-- docs/dev-video-test-data.sql 手工脚本，避免 dev 种子与前端本地 KB 内容打架）。
-- =====================================================================

ALTER TABLE health_articles ADD COLUMN video_key VARCHAR(255) NULL;
