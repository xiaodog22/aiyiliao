package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * V27 电子检查报告详情。按医院纸质报告阅读顺序组织：机构与标题 → 患者信息 →
 * 申请/标本信息 → 分组项目 → 异常提示 → 所见/结论 → 人员与时间 → 附件。
 *
 * statusNotice：非 READY 报告的唯一内容提示；此时 sections/attachments 为空，
 * 且 findingsText/impressionText/conclusionText/recommendationText 全部为 null，
 * 由服务端门禁保证不泄露未经审核的结果（不依赖前端隐藏）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ReportDetailData(
        String recordId,
        String reportNo,
        String title,
        String reportType,
        String reportStatus,
        Boolean isDemo,
        String demoNotice,
        String statusNotice,
        String institutionName,
        String institutionType,
        String departmentName,
        String patientName,
        String patientSex,
        String patientAge,
        String outpatientNo,
        String inpatientNo,
        String clinicalDiagnosis,
        String applicantDoctor,
        String specimenType,
        String specimenNo,
        Instant collectionAt,
        Instant receivedAt,
        Instant testedAt,
        Instant reportedAt,
        String operatorName,
        String reviewerName,
        String inspectionMethod,
        String instrumentModel,
        String findingsText,
        String impressionText,
        String conclusionText,
        String recommendationText,
        List<ReportSectionData> sections,
        List<AttachmentData> attachments
) {
}
