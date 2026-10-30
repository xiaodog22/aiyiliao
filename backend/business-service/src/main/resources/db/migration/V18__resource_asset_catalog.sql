-- =====================================================================
-- V18__resource_asset_catalog.sql —— 资源登记（2026-10-19 由 tools/resource-import.py 生成）
--
-- **不要手改**：改分类规则请改脚本再重跑。
-- 只登记元数据 + 相对路径，二进制留在文件系统（不写 BLOB）。
-- delivery：local = 仅本地兜底（清单不下发 url）/ remote = 远端优先。
-- 本次：新增 5 条、内容变更 0 条。
-- =====================================================================

INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order, delivery)
VALUES
    ('content.cover-exercise', 'cover', 'content/cover-exercise.png', 'image/png', 60501, 'ac06ff89ad382edb0fd1289c0a1c6b45391337b8a30d42256a01c31ac7424ad3', 1, 'A', '/packageContent/assets/covers/cover-exercise.png', 300, 'remote'),
    ('content.cover-nutrition', 'cover', 'content/cover-nutrition.png', 'image/png', 60318, '876aabf2c648118e86c63e969a85c89be712b2ce0744aa8507ec2adce38dc3c7', 1, 'A', '/packageContent/assets/covers/cover-nutrition.png', 301, 'remote'),
    ('content.cover-sleep', 'cover', 'content/cover-sleep.png', 'image/png', 61388, 'b247e0924ec769df95375e79a8b8d4b473295aa107ceaa07d1965810ab0aeedd', 1, 'A', '/packageContent/assets/covers/cover-sleep.png', 302, 'remote'),
    ('content.cover-wellness', 'cover', 'content/cover-wellness.png', 'image/png', 58568, '8b11160420eaa569b1d4aa63940d250bfd38e3f6924aee3550eb9648e7515697', 1, 'A', '/packageContent/assets/covers/cover-wellness.png', 303, 'remote'),
    ('content.detail-hero-sleep', 'cover', 'content/detail-hero-sleep.png', 'image/png', 90113, '806801af55920194a9f1362f7ebe00307257065c43bac835daf324c82c904b97', 1, 'A', '/packageContent/assets/covers/detail-hero-sleep.png', 304, 'remote');
