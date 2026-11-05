package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;

/**
 * V27 检查项目明细（health_report_items 一行）。
 * 数值型用 result_value + reference_low/high；定性/描述型用 result_text。
 * abnormalLabel 由服务端给出中文文字提示——异常不得只靠颜色区分。
 * 本 DTO 为 V27 新增契约（additionalProperties:false），未冒充既有 HealthRecord 字段。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ReportItemData(
        String id,
        String itemCode,
        String itemName,
        BigDecimal resultValue,
        String resultText,
        String unit,
        BigDecimal referenceLow,
        BigDecimal referenceHigh,
        String referenceText,
        String abnormalFlag,
        String abnormalLabel,
        String inspectionMethod,
        String remark,
        Integer sortOrder
) {
}
