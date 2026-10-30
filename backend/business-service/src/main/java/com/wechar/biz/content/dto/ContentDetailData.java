package com.wechar.biz.content.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.time.LocalDate;

/** 契约 ContentDetail = ContentItem + body/source/reviewer（/contents/{id}）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ContentDetailData(String id, String title, String summary, String category, String coverKey,
                                String coverUrl, String contentType, String videoUrl, Integer durationSec,
                                Integer readTimeSec, String reviewStatus, LocalDate effectiveFrom,
                                LocalDate effectiveTo, Instant publishedAt, Integer readCount,
                                String body, String source, String reviewer) {
}
