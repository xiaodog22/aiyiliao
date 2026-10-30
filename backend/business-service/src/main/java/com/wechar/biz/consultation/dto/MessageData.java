package com.wechar.biz.consultation.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/** 契约 Message（role/contentType/provenance/createdAt 必填；其余可选）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MessageData(String id, String role, String contentType, String content, String provenance,
                          List<CitationData> citations, List<String> riskTags, String generationStatus,
                          Instant createdAt) {
}
