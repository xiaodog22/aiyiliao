-- =====================================================================
-- V30__health_push_reports.sql —— 健康档案「系统推送报告」图片远端化（2026-11-15）
--
-- 背景：微信「代码质量」要求主包 <1.5M、图片+音频 ≤200K。两张演示报告单
--   （血常规 / 血压动态监测）此前以包内 /assets/health-push/*.jpg 形式存在，
--   合计约 35KB，属于**低频大图**，符合「远端下发」口径。
--
-- 做法：
--   1) 图片只保留在 backend/deploy/resources/health/ 下（file_path 相对 app.resources.dir）；
--   2) delivery='remote' → 进入资源清单，并可通过匿名端点 GET /api/v1/resources/{key} 读取；
--   3) bundle_path = NULL：包内不再保留兜底副本（断网时前端显示占位，不伪造图片）；
--   4) level='B'：非关键资源，绝不阻断启动与业务接口。
--
-- 图片由 tools/gen-health-push-images.py 生成（Edge 截图 → JPEG），
-- 重新生成后需把 file_size / sha256 拉正（本文件末尾即 UPDATE 示例）。
-- =====================================================================

INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order, delivery)
VALUES
    ('health.report-blood-routine', 'image', 'health/report-blood-routine.jpg', 'image/jpeg', 21304,
     'd0705eb5f1d0bc44c75ce517eeaf1a5081f30fb498f9dfcdb617ec0908571e13', 1, 'B', NULL, 45, 'remote'),
    ('health.report-blood-pressure', 'image', 'health/report-blood-pressure.jpg', 'image/jpeg', 23684,
     'cdc7bb02bf5fe2c56c3f62c7b8864cc0d4c0f5b5419a0eda0241b285f2a0efe6', 1, 'B', NULL, 46, 'remote');
