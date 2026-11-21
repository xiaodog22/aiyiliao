package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * P0-3 报告发布结果（dev 演示入口返回）。
 * messageCreated=false 表示报告已 READY 或该报告的通知此前已写入（幂等命中），不是失败。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ReportReadyData(
        String recordId,
        String reportNo,
        String reportStatus,
        Instant reportedAt,
        Boolean isDemo,
        Boolean messageCreated
) {
}
