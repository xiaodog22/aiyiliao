package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 HealthRecord.attachments 条目（required=[objectKey, mime, size]）。
 * id 为附件行主键（删除时 DELETE .../attachments/{id} 使用）；
 * url 为短期签名 URL（HMAC + TTL），可能已过期；过期时客户端重新拉取档案即得新 URL。
 * fileName 为客户端原始文件名（仅展示）；sha256 供完整性校验。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AttachmentData(
        String id,
        String objectKey,
        String url,
        String fileName,
        String mime,
        long size,
        String sha256,
        Instant createdAt
) {
}
