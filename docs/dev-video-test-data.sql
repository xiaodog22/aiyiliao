-- =====================================================================
-- dev-video-test-data.sql —— 阶段三真机验证用的手工测试数据
--
-- 🚫 **仅本地开发 / 真机调试用。生产与 CI 禁止执行本文件。**
--    · 不在 db/migration、也不在 db/dev，Flyway 永远不会自动应用它；
--    · 执行后会往 health_articles 写入 3 条**假文章**（wash-hands / dev-video-test / dev-video-none）；
--    · **真实内容上线前必须删除这三行**（脚本末尾有 DELETE 语句，取消注释执行即可）；
--    · 生产环境出现这三条 = 事故：`正确洗手七步法` 会用联调视频盖掉真实内容。
-- =====================================================================
--
-- 为什么有三条：
--   wash-hands      ← **真机主用例**：id 必须与本地 KB（utils/knowledge-kb.js）一致，
--                      否则 detail 页 `KB.byId(id)` 找不到内容会直接显示"内容不存在"，
--                      根本走不到视频分支。前端流程是：
--                        KB 渲染（秒开）→ 异步 GET /health-articles/wash-hands
--                        → 拿到 videoUrl → 覆盖基准源；失败则保持基准源
--                        （资源端点直拼，F2 Phase B 起包内 mp4 已删，不再有"包内 mp4"可回退）。
--   dev-video-test  ← 直接 curl 接口用（验证 videoUrl / TTL / 410 / 403）
--   dev-video-none  ← 对照：无 video_key → 响应不应出现 videoUrl 字段
--
-- 用法（三步）：
--   1) 把视频复制成附件目录里的固定文件名（32 位小写 hex + .mp4）。
--      ⚠️ 源文件在 **服务端副本**（包内 mp4 已于 2026-11-05 出包删除）：
--        cp backend/deploy/resources/wash-hands.mp4 \
--           backend/business-service/run/uploads/attachments/dddddddddddddddddddddddddddddddd.mp4
--      Windows PowerShell：Copy-Item 源 目标 -Force
--   2) 执行本脚本（**必须带 utf8mb4**，否则 Windows 的 mysql CLI 会报 1366）：
--        mysql --default-character-set=utf8mb4 -u wechar_dev -p wechar_dev < docs/dev-video-test-data.sql
--   3) 验证：
--        curl -s --noproxy '*' http://127.0.0.1:8080/api/v1/health-articles/wash-hands
--      期望 data.videoUrl 形如 /api/v1/attachments/dddd….mp4?expires=…&sig=…
--
-- 注意：video_key 指向的文件必须真实存在，否则详情能拿到 URL 但播放 404。
-- =====================================================================

-- ---------- 主用例：与本地 KB 同 id，真机从科普列表点进详情即可命中 ----------
DELETE FROM health_articles WHERE id = 'wash-hands';
INSERT INTO health_articles
    (id, title, summary, cover_key, category, type, read_min, published_at, sections_json, tip, related_json, video_key, status)
VALUES
    ('wash-hands', '正确洗手七步法', '用流动水与皂液，按七步法揉搓至少 20 秒。', NULL,
     '日常防护', 'video', 2, NOW(3), NULL, '饭前便后、外出回家后都要洗手。', NULL,
     'dddddddddddddddddddddddddddddddd.mp4', 'PUBLISHED');

-- ---------- 接口直测用 ----------
DELETE FROM health_articles WHERE id = 'dev-video-test';
INSERT INTO health_articles
    (id, title, summary, cover_key, category, type, read_min, published_at, sections_json, tip, related_json, video_key, status)
VALUES
    ('dev-video-test', '视频远端测试', '阶段三真机验证用：详情应返回签名 videoUrl', NULL,
     '日常防护', 'video', 2, NOW(3), NULL, '观看后请确认能播放、能拖动进度条。', NULL,
     'dddddddddddddddddddddddddddddddd.mp4', 'PUBLISHED');

-- ---------- 对照：无 video_key ----------
DELETE FROM health_articles WHERE id = 'dev-video-none';
INSERT INTO health_articles
    (id, title, summary, cover_key, category, type, read_min, published_at, sections_json, tip, related_json, video_key, status)
VALUES
    ('dev-video-none', '无视频对照', '对照用例：响应里不应出现 videoUrl 字段', NULL,
     '日常防护', 'article', 3, NOW(3), NULL, NULL, NULL, NULL, 'PUBLISHED');

-- 验证查询
SELECT id, title, type, video_key, status FROM health_articles
 WHERE id IN ('wash-hands', 'dev-video-test', 'dev-video-none');

-- 清理（联调结束后执行）
-- DELETE FROM health_articles WHERE id IN ('wash-hands', 'dev-video-test', 'dev-video-none');
