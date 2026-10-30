-- =====================================================================
-- V15__resource_asset_delivery.sql —— 资源投递方式（2026-10-19）
--
-- 背景：V14 只有 status，无法表达「这个资源该不该走远端」。
--   直接把 219 个 96×96 图标全推上 CDN/隧道是净亏：每个图标一次网络往返，
--   而它们本来就在包里（0ms 可取）。需要显式区分。
--
-- delivery 语义（唯一真源，清单与端点都读它）：
--   local  = 仅本地兜底：DB 可查、端点可取，但**清单不下发 url**（前端用 bundle_path）
--   remote = 远端优先：清单下发 `{public-base-url}/api/v1/resources/{key}`，前端远端失败回退 bundle_path
--
-- 默认值取 local 是**安全默认**：新增资源不会因为漏填而误上云。
-- 分类规则见 docs/资源库分类规则_20261019.md §3。
-- =====================================================================

ALTER TABLE resource_asset ADD COLUMN delivery VARCHAR(8) NOT NULL DEFAULT 'local';

-- 封面 / 科普图 / 视频 → remote（大图、低频、需要可独立更新而不发版）
UPDATE resource_asset
   SET delivery = 'remote'
 WHERE resource_key IN (
        'home.banner-hospital',
        'health.wash-hands', 'health.measure-bp', 'health.stand-up',
        'video.wash-hands', 'video.measure-bp', 'video.stand-up'
 );

-- 其余保持 local（默认值）：
--   home.ai-doctor、home.svc-*（首页高频小图）、legacy.disabled-sample（停用样本）
