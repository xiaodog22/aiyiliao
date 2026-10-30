package com.wechar.biz.content.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.time.LocalDate;

/**
 * 契约 ContentItem（additionalProperties:false：id/title/category/reviewStatus 必填；
 * reviewStatus 枚举 DRAFT/PENDING_REVIEW/APPROVED/REJECTED/RETIRED —— 只有 APPROVED 对用户可见）。
 * contentType：ARTICLE/VIDEO；durationSec 仅视频；readTimeSec 仅图文（估算阅读秒数）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ContentItemData(String id, String title, String summary, String category, String coverKey,
                              String coverUrl, String contentType, String videoUrl, Integer durationSec,
                              Integer readTimeSec, String reviewStatus, LocalDate effectiveFrom,
                              LocalDate effectiveTo, Instant publishedAt, Integer readCount) {
}
