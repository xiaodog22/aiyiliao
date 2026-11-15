package com.wechar.biz.consultation.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/** 契约 Message（role/contentType/provenance/createdAt 必填；其余可选）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MessageData(String id, String role, String contentType, String content, String provenance,
                          List<CitationData> citations, List<String> riskTags, String generationStatus,
                          Instant createdAt,
                          // 图片消息（contentType=IMAGE_NOTE）的展示信息：服务端反查健康档案附件后下发，
                          // 医生端/患者端据此渲染同一张图，不再显示裸 objectKey（2026-11-15）。
                          String attachmentUrl, String attachmentName, String attachmentMime,
                          Long attachmentSize) {
}
