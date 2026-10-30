-- =====================================================================
-- V20__resource_asset_catalog.sql —— 资源登记（2026-10-21 由 tools/resource-import.py 生成）
--
-- **不要手改**：改分类规则请改脚本再重跑。
-- 只登记元数据 + 相对路径，二进制留在文件系统（不写 BLOB）。
-- delivery：local = 仅本地兜底（清单不下发 url）/ remote = 远端优先。
-- 本次：新增 1 条、内容变更 1 条。
-- =====================================================================

INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order, delivery)
VALUES
    ('icons.chatMint', 'icon', 'icons/chat_mint.png', 'image/png', 3658, 'e4a71a3220d488cc84e23ba225184b94a4077e324c3c01a311a4909de1f4c4ad', 1, 'A', '/assets/icons/chat_mint.png', 300, 'local');

-- 内容变更：源文件已替换，把 size/sha256 拉正（否则端点 ETag 与文件不符、对账会红）
UPDATE resource_asset SET file_size = 61212, sha256 = 'e64250fdb7ab73bddaec8afd26be27098c5abfd456c7715373d2d56a1c7155ce', status = 1 WHERE resource_key = 'home.xiaoan-robot';

-- 登录页主视觉小安改为「远端优先」（2026-10-21）：
-- 原图腰部 alpha 缺口在包内修不掉，改由 GET /api/v1/resources/home.xiaoan-robot 下发，
-- 纠错无需重新发版；bundle_path 仍指向同版包内文件，弱网/失败时回退（清单校验要求 remote 必须有 bundle_path）。
UPDATE resource_asset SET delivery = 'remote' WHERE resource_key = 'home.xiaoan-robot';
