-- =====================================================================
-- V14__resource_asset.sql —— 图片/图标资源元数据表（2026-10-19）
--
-- 目标：把图片/图标从「打进主包 + 文件系统白名单直读」升级为「数据库登记 key +
--       Spring Boot 按 key 流式返回」，前端通过 key 获取远端地址，本地 bundle 兜底。
--
-- 设计原则（硬约束）：
--   1) **只存路径与元数据，不存图片 BLOB**：file_path 为相对 `app.resources.dir`
--      的路径，二进制永远在文件系统上，由 FileSystemResource 零拷贝输出。
--   2) resource_key 唯一 = 稳定检索入口；业务代码只认 key，不认文件名与目录。
--   3) status = 1 才对外可见（停用即 404，不靠删除行）。
--   4) level 沿用契约 ResourceItem.level（A=关键资源，客户端必须保留本地兜底；
--      B=非关键）。bundle_path 即清单 fallbackKey，前端远端失败时回退此路径。
--   5) sort_order 决定清单下发顺序（稳定排序，避免 items[0] 因物理顺序漂移）。
--
-- 种子数据 = `backend/deploy/resources/` 中**真实存在**的文件，
--   file_size / sha256 由构建期实算写入（见 docs/资源库与真机验证_20261019.md §验证）。
--   视频（video/mp4）登记在本表用于 `<video>` 取流，但**不下发进资源清单**
--   （清单 contract 只允许图片 mime，见 ResourceManifestService）。
-- =====================================================================

CREATE TABLE resource_asset (
    id           BIGINT       NOT NULL AUTO_INCREMENT,
    resource_key VARCHAR(128) NOT NULL COMMENT '业务唯一 key，如 home/svc-triage',
    category     VARCHAR(32)  NOT NULL COMMENT 'icon / image / cover / avatar / video',
    file_path    VARCHAR(512) NOT NULL COMMENT '相对 app.resources.dir 的路径（禁止绝对路径与 ..）',
    mime_type    VARCHAR(128) NOT NULL,
    file_size    BIGINT       NULL,
    sha256       CHAR(64)     NULL,
    status       TINYINT      NOT NULL DEFAULT 1 COMMENT '1 启用 / 0 停用（停用对外 404）',
    level        VARCHAR(1)   NOT NULL DEFAULT 'B' COMMENT '契约 ResourceItem.level：A | B',
    bundle_path  VARCHAR(255) NULL COMMENT '小程序包内兜底路径（清单 fallbackKey）',
    sort_order   INT          NOT NULL DEFAULT 100 COMMENT '清单下发顺序（升序）',
    created_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at   DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_resource_asset_key (resource_key),
    KEY idx_resource_asset_status (status, sort_order)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;

-- ---------------------------------------------------------------- 头像 / A 级关键图标
INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order)
VALUES
    ('home.ai-doctor', 'avatar', 'ai-doctor.png', 'image/png', 12518,
     '2b780ccb244a0567bde5ad3eb1eb15f19f703ea8346ed8b1d2ff372bd6432152', 1, 'A', '/assets/home/ai-doctor.png', 10),
    ('home.svc-triage', 'icon', 'svc-triage.png', 'image/png', 3269,
     '7b397297fbfdcd0aa324047840eb6a6c4bdbe1500ea7615a1fcc21b046e0cfcc', 1, 'A', '/assets/home/svc-triage.png', 20),
    ('home.svc-doctor', 'icon', 'svc-doctor.png', 'image/png', 3206,
     '82739fda23d0aca629558395b94db4669467b2fa4cabcf08272b64424ddfea53', 1, 'A', '/assets/home/svc-doctor.png', 21),
    ('home.svc-dept', 'icon', 'svc-dept.png', 'image/png', 3140,
     '9d0b27ed7ae9f1e0bfbf66c62984f7795bde8de4efacb543998f3f2b18747527', 1, 'A', '/assets/home/svc-dept.png', 22),
    ('home.svc-checkup', 'icon', 'svc-checkup.png', 'image/png', 3596,
     '22d4bbae4d23d201e3e2f8f80a17b42622580e6aff63f2bb7c127ec97dcf7865', 1, 'A', '/assets/home/svc-checkup.png', 23),
    ('home.svc-archive', 'icon', 'svc-archive.png', 'image/png', 3589,
     'c01e832f432e0e7cad85f6dbb9a27a822c8dd69352d217f52fb52f03638d0705', 1, 'A', '/assets/home/svc-archive.png', 24),
    ('home.svc-care', 'icon', 'svc-care.png', 'image/png', 3165,
     '7c35577a25fd77e24f799af3559ea8b370570960965490dbb4b6eb701f0983a7', 1, 'A', '/assets/home/svc-care.png', 25),
    ('home.svc-advice', 'icon', 'svc-advice.png', 'image/png', 3042,
     '5e015b2feebb52b8376c79d386baa6d3f9b8a0ac95c3f2914cae84965eaf672f', 1, 'A', '/assets/home/svc-advice.png', 26),
    ('home.svc-more', 'icon', 'svc-more.png', 'image/png', 3012,
     'a107827e90ca1e17c374f59f51c920facb75e90be27f3021d1832548d88b57b1', 1, 'A', '/assets/home/svc-more.png', 27);

-- ---------------------------------------------------------------- B 级封面 / 图文
INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order)
VALUES
    ('home.banner-hospital', 'cover', 'banner-hospital.jpg', 'image/jpeg', 26535,
     '70bdd2ccfb661129a3326f23c4244c364af7ee9cd2aff8de3bfc8d421ed4e89c', 1, 'B',
     '/assets/home/banner-hospital.jpg', 30),
    ('health.wash-hands', 'image', 'wash-hands.jpg', 'image/jpeg', 21932,
     '7f17b53dedf4b31292c8216e7fbdc7ec698d4d142302da4899cb1227f9f47799', 1, 'B',
     '/packageContent/videos/wash-hands.jpg', 40),
    ('health.measure-bp', 'image', 'measure-bp.jpg', 'image/jpeg', 23936,
     'aaffcf628b46080cc2cc8f2e248966560d609bc3ad8505100517f23613b08028', 1, 'B',
     '/packageContent/videos/measure-bp.jpg', 41),
    ('health.stand-up', 'image', 'stand-up.jpg', 'image/jpeg', 23821,
     '1386e056f615bc013d17e512acba392586beb4cf8cea38c5ca418e13e82021fb', 1, 'B',
     '/packageContent/videos/stand-up.jpg', 42);

-- ---------------------------------------------------------------- 视频（列表可达，清单不下发）
INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order)
VALUES
    ('video.wash-hands', 'video', 'wash-hands.mp4', 'video/mp4', 54887,
     '30d48def50f88416714e4bf562a807e0b4aa9a0aa769bfbb0149e11731209a58', 1, 'B',
     '/packageContent/videos/wash-hands.mp4', 60),
    ('video.measure-bp', 'video', 'measure-bp.mp4', 'video/mp4', 59917,
     '0541aff35a45b744140d3a9f6a67c1f2905e27d60c70feb80c9c81c470a121d5', 1, 'B',
     '/packageContent/videos/measure-bp.mp4', 61),
    ('video.stand-up', 'video', 'stand-up.mp4', 'video/mp4', 54806,
     '5b340de89d78610b772338151197dc00223e06c4fa839d259c19ed1f02d52f91', 1, 'B',
     '/packageContent/videos/stand-up.mp4', 62);

-- ---------------------------------------------------------------- 停用样本（验收 status=0 → 404）
-- 元数据合法、文件真实存在，仅 status=0：用于证明「停用即不可达」，而不是靠删行。
INSERT INTO resource_asset
    (resource_key, category, file_path, mime_type, file_size, sha256, status, level, bundle_path, sort_order)
VALUES
    ('legacy.disabled-sample', 'icon', 'svc-more.png', 'image/png', 3012,
     'a107827e90ca1e17c374f59f51c920facb75e90be27f3021d1832548d88b57b1', 0, 'B', NULL, 99);
