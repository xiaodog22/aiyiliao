-- =====================================================================
-- V13__health_articles.sql —— N12/N13 健康科普内容表（2026-10-19）
-- 事实源：docs/接口需求_待后端实现_20261019.md §三轮 N12/N13 + backend/contracts/business-openapi.yaml
-- 约定：服务端下发动态科普（分类/搜索/分页）；cover_key 引用 Attachment 对象键，
--      响应内 coverUrl 由服务端生成 HMAC 短 TTL 签名 URL；本地 knowledge-kb.js 为离线降级。
--      内容由运营侧录入（dev 种子见 db/dev/V9004），生产空表 = 前端降级，不伪造内容。
-- =====================================================================

CREATE TABLE health_articles (
    id            VARCHAR(64)  NOT NULL,
    title         VARCHAR(120) NOT NULL,
    summary       VARCHAR(300) NULL,
    cover_key     VARCHAR(255) NULL,
    category      VARCHAR(32)  NOT NULL,
    type          VARCHAR(16)  NOT NULL DEFAULT 'article',
    read_min      INT          NULL,
    published_at  DATETIME(3)  NOT NULL,
    sections_json TEXT         NULL,
    tip           VARCHAR(300) NULL,
    related_json  VARCHAR(1000) NULL,
    status        VARCHAR(16)  NOT NULL DEFAULT 'PUBLISHED',
    created_at    DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    KEY idx_health_articles_status (status, category, published_at)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
