package com.wechar.biz.triage.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 TriageResult.recommendedDepartments 元素（必填 departmentId/departmentName/provenance）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record RecommendedDepartment(String departmentId, String departmentName, String reason,
                                    String provenance, Double confidence) {
}
