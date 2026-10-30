package com.wechar.biz.consultation.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 Citation（sourceId/title 必填；未通过审核的资料不得作为来源展示）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CitationData(String sourceId, String title, String version, String effectiveFrom, String url) {
}
