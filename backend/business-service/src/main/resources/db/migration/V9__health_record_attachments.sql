-- =====================================================================
-- V9__health_record_attachments.sql —— 健康档案检查资料附件（2026-10-18）
-- 用户诉求：首页「报告查询」→ 健康档案页「检查资料」分区支持上传（拍照/相册/文件）、
--   查看（短期签名 URL）、删除（二次确认）。V4 规范 §8.13。
-- 设计：
--   附件独立成表（1:N 于 health_records）：record_id + user_id 双锚定防越权；
--   object_key = 服务端生成的 32 位 hex + 扩展名白名单（客户端输入不参与路径）；
--   file_name 仅保存客户端原始文件名用于展示；sha256 供完整性校验。
-- 约定沿用 V1：utf8mb4、DATETIME(3) UTC、主键应用生成 VARCHAR(64)。
-- =====================================================================

CREATE TABLE health_record_attachments (
    id          VARCHAR(64)  NOT NULL,
    record_id   VARCHAR(64)  NOT NULL,
    user_id     VARCHAR(64)  NOT NULL,
    object_key  VARCHAR(64)  NOT NULL,
    file_name   VARCHAR(255) NULL,
    mime        VARCHAR(80)  NOT NULL,
    size        BIGINT       NOT NULL,
    sha256      CHAR(64)     NOT NULL,
    created_at  DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (id),
    UNIQUE KEY uq_hr_attach_record_object (record_id, object_key),
    KEY idx_hr_attach_record (record_id),
    KEY idx_hr_attach_user (user_id),
    CONSTRAINT fk_hr_attach_record FOREIGN KEY (record_id) REFERENCES health_records (id) ON DELETE CASCADE,
    CONSTRAINT fk_hr_attach_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;
