-- =====================================================================
-- V23__resource_asset_catalog.sql —— 资源登记（2026-10-29 由 tools/resource-import.py 生成）
--
-- **不要手改**：改分类规则请改脚本再重跑。
-- 只登记元数据 + 相对路径，二进制留在文件系统（不写 BLOB）。
-- delivery：local = 仅本地兜底（清单不下发 url）/ remote = 远端优先。
-- 本次：新增 7 条、内容变更 1 条。
-- =====================================================================

INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order, delivery)
VALUES
    ('icons.share', 'icon', 'icons/share.png', 'image/png', 2435, 'aadc26709bbac618c4a594a8ac9a83eb1f9c7882a2d0562489477c5587db76db', 1, 'A', '/assets/icons/share.png', 300, 'local'),
    ('icons.shareGray', 'icon', 'icons/share_gray.png', 'image/png', 2699, '64dd0d46a8bfb98ae7aea66b2120a12bd2ab05fed24c64a31981d07a105b952d', 1, 'A', '/assets/icons/share_gray.png', 301, 'local'),
    ('icons.shareWhite', 'icon', 'icons/share_white.png', 'image/png', 1630, '73592c6249fa06c4d4fe7db9b38553f362a2c325cb328bb0ec713e67e4b3df14', 1, 'A', '/assets/icons/share_white.png', 302, 'local'),
    ('icons.soundWave', 'icon', 'icons/soundWave.png', 'image/png', 5106, '613b0a8c19492e58b4f8cdc928dc140838e86562ebb8099ccb0a5601fed8617d', 1, 'A', '/assets/icons/soundWave.png', 303, 'local'),
    ('icons.soundWaveGray', 'icon', 'icons/soundWave_gray.png', 'image/png', 5416, '0d5d6480ade3fdc7f719dc9ede17ce59784813689591da91d63c710222f20378', 1, 'A', '/assets/icons/soundWave_gray.png', 304, 'local'),
    ('icons.soundWaveWhite', 'icon', 'icons/soundWave_white.png', 'image/png', 2555, '506924984ffc63f40f2d4a18ef96a21188bc7040c3b8762824886853c621feda', 1, 'A', '/assets/icons/soundWave_white.png', 305, 'local'),
    ('icons.alertAmber', 'icon', 'icons/alert_amber.png', 'image/png', 2627, '57a63921f411f2b23a62044c6f6f8f39bfdac915110646c39f1a1964d8fa409b', 1, 'A', '/assets/icons/alert_amber.png', 306, 'local');

-- 内容变更：源文件已替换，把 size/sha256 拉正（否则端点 ETag 与文件不符、对账会红）
UPDATE resource_asset SET file_size = 23960, sha256 = 'fe6e5cde49d2a8fcd8b44faf2507834f67c7011cec5b50bbca72fe684b2fd17e', status = 1 WHERE resource_key = 'nav.floor1';
