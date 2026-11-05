package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** V27 报告分组（health_report_sections）及其项目明细。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ReportSectionData(
        String id,
        String sectionCode,
        String sectionName,
        Integer sortOrder,
        List<ReportItemData> items
) {
}
