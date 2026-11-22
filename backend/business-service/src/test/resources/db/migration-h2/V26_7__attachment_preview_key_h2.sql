-- H2 单测专用补丁：B2（生产 V27 的 health_record_attachments.preview_object_key）。
--
-- H2 档 Flyway target 锁在 26.x，V27 的 MySQL 多列 ALTER 不会执行；
-- 附件孤儿清理的引用查询必须覆盖真实列 preview_object_key，否则
-- AttachmentReferenceRepositoryIT 只能测到 object_key，回归会被 mock 掩盖。
-- 与生产同语义，只补本用例需要的单列（V27 其余报告结构仍由真实 MySQL 验收）。

ALTER TABLE health_record_attachments
    ADD COLUMN IF NOT EXISTS preview_object_key VARCHAR(64) NULL;
