package com.wechar.biz.home.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 任务书 GET /api/v1/home 的 HomeBrief：
 *  reminderType ∈ {BIND_PHONE, UPCOMING_APPOINTMENT, AI_GUIDANCE}；
 *  仅 UPCOMING_APPOINTMENT 携带 appointmentId；问候语按 Asia/Shanghai。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HomeBriefData(String greeting, String reminderType, String appointmentId) {
}
