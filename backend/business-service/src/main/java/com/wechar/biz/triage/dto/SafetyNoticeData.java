package com.wechar.biz.triage.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 SafetyNotice（必填 emergency/level）。provenance=RULE_RESULT（规则结果，不伪装 AI）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SafetyNoticeData(Boolean emergency, String level, String message, String provenance,
                               String ruleSetVersion) {
}
