package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.patient.dto.AttachmentData;
import com.wechar.biz.patient.dto.ReportDetailData;
import com.wechar.biz.patient.dto.ReportItemData;
import com.wechar.biz.patient.dto.ReportSectionData;
import com.wechar.biz.patient.dto.ReportSummaryData;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * V27 电子检查报告读模型。
 *
 * 状态门禁（后端唯一裁决点，前端隐藏不算隔离）：
 * 只有 health_records.report_status = 'READY' 的报告才返回 sections/items/findings/
 * impression/conclusion/recommendation/attachments；REVIEWING、PENDING 或 NULL 一律返回
 * 脱敏 DTO（仅机构、编号、状态、时间等元信息 + 文字提示），且根本不查询明细表。
 * 该口径同时覆盖新增的 /reports 详情与既有 /health-records 读路径（见 PatientService）。
 */
@Service
public class HealthReportService {

    private static final Set<String> REPORT_TYPES =
            Set.of("LAB", "IMAGING", "CHECKUP", "PATHOLOGY", "ECG");
    private static final Set<String> STATUSES = Set.of("READY", "REVIEWING", "PENDING");

    private static final Map<String, String> ABNORMAL_LABELS = Map.of(
            "NORMAL", "正常",
            "HIGH", "偏高",
            "LOW", "偏低",
            "POSITIVE", "阳性",
            "NEGATIVE", "阴性",
            "ABNORMAL", "异常",
            "NOT_APPLICABLE", "不适用");

    private final HealthReportRepository reports;
    private final HealthRecordRepository healthRecords;
    private final AttachmentRepository attachments;
    private final AttachmentStorage storage;

    public HealthReportService(HealthReportRepository reports, HealthRecordRepository healthRecords,
                               AttachmentRepository attachments, AttachmentStorage storage) {
        this.reports = reports;
        this.healthRecords = healthRecords;
        this.attachments = attachments;
        this.storage = storage;
    }

    /**
     * 未出具报告判定（后端唯一口径，PatientService 复用本方法保证新旧接口同源）。
     * 只有明确处于 PENDING / REVIEWING 的报告类档案才脱敏：
     * reportStatus == null 按契约表示「非报告类或状态未知」，若一并锁住会把建档时
     * status 为 null 的普通检查资料（含附件）误伤——实测 M9AttachmentTest 回归已确认。
     */
    public static boolean isUnpublishedReport(String category, String reportStatus) {
        return "EXAM".equals(category) && reportStatus != null && !"READY".equals(reportStatus);
    }

    private static Instant dayStart(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return LocalDate.parse(value.trim()).atStartOfDay(ZoneOffset.UTC).toInstant();
        } catch (DateTimeParseException e) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "from/to 必须为 yyyy-MM-dd 格式");
        }
    }

    private static Instant dayAfter(String value) {
        Instant start = dayStart(value);
        return start == null ? null : start.plusSeconds(86400);
    }

    private static void requireEnum(String value, Set<String> allowed, String field) {
        if (value != null && !value.isBlank() && !allowed.contains(value)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    field + " 必须为 " + allowed + " 之一");
        }
    }

    @Transactional(readOnly = true)
    public List<ReportSummaryData> listReports(String userId, String reportType, String status,
                                               String familyMemberId, String from, String to,
                                               int limit) {
        requireEnum(reportType, REPORT_TYPES, "reportType");
        requireEnum(status, STATUSES, "status");
        return reports.listSummaries(userId,
                        blankToNull(reportType), blankToNull(status), blankToNull(familyMemberId),
                        dayStart(from), dayAfter(to), limit).stream()
                .map(r -> new ReportSummaryData(r.recordId(), r.reportNo(), r.title(), r.reportType(),
                        r.institutionName(), r.departmentName(), r.patientName(), r.reportStatus(),
                        r.familyMemberId(), r.recordedAt(), r.reportedAt(), r.abnormalCount(), r.isDemo()))
                .toList();
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    @Transactional(readOnly = true)
    public ReportDetailData getReport(String userId, String recordId) {
        // 归属校验：越权 404（与既有 /health-records/{id} 口径一致）
        var record = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "检查报告不存在"));
        var detail = reports.findDetail(userId, recordId)
                .orElseThrow(() -> new ApiException("REPORT_DETAIL_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "该档案暂无电子检查报告明细"));

        boolean unpublished = isUnpublishedReport(record.category(), record.reportStatus());
        if (unpublished) {
            // 非 READY：只返回元信息；结论、所见、分组、项目、附件一律不查、不返回
            return new ReportDetailData(recordId, detail.reportNo(), record.title(),
                    detail.reportType(), record.reportStatus(), detail.isDemo(), detail.demoNotice(),
                    statusNotice(record.reportStatus()), detail.institutionName(),
                    detail.institutionType(), detail.departmentName(), detail.patientName(),
                    detail.patientSex(), detail.patientAge(), null, null, null, null,
                    null, null, detail.collectionAt(), detail.receivedAt(), detail.testedAt(),
                    detail.reportedAt(), null, null, null, null,
                    null, null, null, null, List.of(), List.of());
        }

        var sections = reports.listSections(detail.id(), userId);
        var items = reports.listItems(detail.id(), userId);
        Map<String, List<ReportItemData>> grouped = new LinkedHashMap<>();
        for (var s : sections) {
            grouped.put(s.id(), new ArrayList<>());
        }
        for (var i : items) {
            grouped.computeIfAbsent(i.sectionId(), k -> new ArrayList<>())
                    .add(new ReportItemData(i.id(), i.itemCode(), i.itemName(), i.resultValue(),
                            i.resultText(), i.unit(), i.referenceLow(), i.referenceHigh(),
                            i.referenceText(), i.abnormalFlag(),
                            ABNORMAL_LABELS.getOrDefault(i.abnormalFlag(), "未判定"),
                            i.inspectionMethod(), i.remark(), i.sortOrder()));
        }
        List<ReportSectionData> sectionData = new ArrayList<>();
        for (var s : sections) {
            sectionData.add(new ReportSectionData(s.id(), s.sectionCode(), s.sectionName(),
                    s.sortOrder(), grouped.getOrDefault(s.id(), List.of())));
        }
        // 未分组项目（section_id 为 NULL）单独兜底成一个分组，避免静默丢数据
        List<ReportItemData> ungrouped = grouped.get(null);
        if (ungrouped != null && !ungrouped.isEmpty()) {
            sectionData.add(new ReportSectionData(null, "UNGROUPED", "其他项目",
                    Integer.MAX_VALUE, ungrouped));
        }

        List<AttachmentData> files = attachments.listByRecord(recordId).stream()
                .map(a -> new AttachmentData(a.id(), a.objectKey(), storage.signedUrl(a.objectKey()),
                        a.fileName(), a.mime(), a.size(), a.sha256(), a.createdAt()))
                .toList();

        return new ReportDetailData(recordId, detail.reportNo(), record.title(),
                detail.reportType(), record.reportStatus(), detail.isDemo(), detail.demoNotice(),
                null, detail.institutionName(), detail.institutionType(), detail.departmentName(),
                detail.patientName(), detail.patientSex(), detail.patientAge(),
                detail.outpatientNo(), detail.inpatientNo(), detail.clinicalDiagnosis(),
                detail.applicantDoctor(), detail.specimenType(), detail.specimenNo(),
                detail.collectionAt(), detail.receivedAt(), detail.testedAt(), detail.reportedAt(),
                detail.operatorName(), detail.reviewerName(), detail.inspectionMethod(),
                detail.instrumentModel(), detail.findingsText(), detail.impressionText(),
                detail.conclusionText(), detail.recommendationText(), sectionData, files);
    }

    private static String statusNotice(String status) {
        return switch (status == null ? "" : status) {
            case "REVIEWING" -> "报告待审核，检查结果暂不展示";
            case "PENDING" -> "报告待出结果，检查结果暂不展示";
            default -> "报告尚未出具，检查结果暂不展示";
        };
    }
}
