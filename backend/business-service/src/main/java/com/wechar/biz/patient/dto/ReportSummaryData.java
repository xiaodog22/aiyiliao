package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/** V27 报告列表卡片：一条 health_records + 一条 health_report_details。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ReportSummaryData(
        String recordId,
        String reportNo,
        String title,
        String reportType,
        String institutionName,
        String departmentName,
        String patientName,
        String reportStatus,
        String familyMemberId,
        Instant recordedAt,
        Instant reportedAt,
        Integer abnormalCount,
        Boolean isDemo
) {
}
