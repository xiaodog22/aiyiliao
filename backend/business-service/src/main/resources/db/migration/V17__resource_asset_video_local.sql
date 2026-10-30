-- =====================================================================
-- V17__resource_asset_video_local.sql —— 视频收口：3 条 video.* 改 local（2026-10-19）
--
-- 背景（核实结论）：V15 曾把 3 条 video.* 标为 delivery='remote'，但那是**死标记**：
--   ① 清单查询有 `mime_type IN ('image/png','image/jpeg','image/webp')` 过滤，mp4 永远进不去；
--   ② 前端科普详情页的视频源写死在 knowledge-kb.js：
--        video: '/packageContent/videos/wash-hands.mp4'
--      完全走分包本地文件，从不向后端要 URL；
--   ③ health_articles 表没有 video 字段（只有 cover_key），后端也没有视频下发接口。
--   → 标 remote 只会在报告里虚增 remote 数，没有任何消费路径，故改回 local。
--
-- 保留 bundle_path：包内 mp4 路径仍是唯一可用的播放源。
-- 远端化方案（health_articles.video_key + 附件签名 URL + <video> 接线）见
-- docs/视频远端化需求.md，**本轮不实现**。
-- =====================================================================

UPDATE resource_asset
   SET delivery = 'local'
 WHERE resource_key IN ('video.wash-hands', 'video.measure-bp', 'video.stand-up')
   AND delivery <> 'local';
