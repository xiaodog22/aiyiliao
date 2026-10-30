package com.wechar.biz.triage.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** 契约 TriageResult（必填 safety；limitations 必须出现）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TriageResultData(SafetyNoticeData safety, List<RecommendedDepartment> recommendedDepartments,
                               String guidance, String limitations) {
}
