-- =====================================================================
-- V9016__health_record_push_report_images.sql —— 健康档案报告图片绑定（2026-11-15）
--
-- 背景：院内系统推送的报告图片已登记在 resource_asset（health.report-blood-routine /
--       health.report-blood-pressure），但 health_record_attachments 从未写入任何行，
--       健康档案卡片没有「系统推送资料」缩略图，点「查看报告」只能降级到结构化报告单。
--
-- 机制：health_record_attachments.object_key = 'res:<resourceKey>'（哨兵前缀，无磁盘文件）。
--       PatientService.toAttachment 识别该前缀后下发 resourceKey 与
--       /api/v1/resources/{key}（匿名资源端点），客户端按图片预览。
--
-- 幂等：固定主键 + INSERT IGNORE；档案不存在时 SELECT 无行，整条安全跳过。
-- 仅 dev profile 加载（application.yml dev 段追加 classpath:db/dev）。
-- =====================================================================

-- ① 血常规检查报告（hr-demo-exam-cbc，READY）
INSERT IGNORE INTO health_record_attachments
    (id, record_id, user_id, object_key, file_name, mime, size, sha256,
     created_at, attachment_type, display_name, sort_order)
SELECT 'hra-v9016-cbc-report', r.id, r.user_id, CONCAT('res:', a.resource_key),
       '血常规检查报告.jpg', a.mime_type, a.file_size, a.sha256,
       '2026-11-04 20:49:18.880', 'REPORT', '血常规检查报告', 10
FROM health_records r
JOIN resource_asset a
  ON a.resource_key = 'health.report-blood-routine' AND a.status = 1
WHERE r.id = 'hr-demo-exam-cbc';

-- ② 血压记录（演示账号最近一条 VITALS「血压记录」→ 血压动态监测报告图）
INSERT IGNORE INTO health_record_attachments
    (id, record_id, user_id, object_key, file_name, mime, size, sha256,
     created_at, attachment_type, display_name, sort_order)
SELECT 'hra-v9016-bp-report', r.id, r.user_id, CONCAT('res:', a.resource_key),
       '血压动态监测报告.jpg', a.mime_type, a.file_size, a.sha256,
       r.recorded_at, 'REPORT', '血压动态监测报告', 10
FROM health_records r
JOIN resource_asset a
  ON a.resource_key = 'health.report-blood-pressure' AND a.status = 1
WHERE r.user_id = 'u-dev-user-1' AND r.category = 'VITALS' AND r.title = '血压记录'
ORDER BY r.created_at DESC
LIMIT 1;
