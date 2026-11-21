package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.message.MessageService;
import com.wechar.biz.patient.dto.AttachmentData;
import com.wechar.biz.patient.dto.ReportDetailData;
import com.wechar.biz.patient.dto.ReportItemData;
import com.wechar.biz.patient.dto.ReportReadyData;
import com.wechar.biz.patient.dto.ReportSectionData;
import com.wechar.biz.patient.dto.ReportSummaryData;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
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
    private final MessageService messages;
    private final Clock clock;
    /** P0-3 回退开关：关闭后仍可发布报告状态，只是不写站内消息。 */
    private final boolean notifyEnabled;

    public HealthReportService(HealthReportRepository reports, HealthRecordRepository healthRecords,
                               AttachmentRepository attachments, AttachmentStorage storage,
                               MessageService messages, Clock clock,
                               @Value("${app.report.notify-enabled:true}") boolean notifyEnabled) {
        this.reports = reports;
        this.healthRecords = healthRecords;
        this.attachments = attachments;
        this.storage = storage;
        this.messages = messages;
        this.clock = clock;
        this.notifyEnabled = notifyEnabled;
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
                        r.familyMemberId(), r.recordedAt(), r.reportedAt(), r.abnormalCount(),
                        r.sourceSystem(), r.externalReportId(), r.reviewerName(), r.examRequestNo(),
                        r.referenceRangeNote(), r.isDemo()))
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
                    detail.sourceSystem(), detail.externalReportId(), detail.examRequestNo(), null,
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
                .map(a -> {
                    // 系统推送的报告图片：object_key = "res:<resourceKey>"，无磁盘对象
                    String key = a.objectKey() == null ? "" : a.objectKey();
                    if (key.startsWith("res:")) {
                        String resourceKey = key.substring(4);
                        return new AttachmentData(a.id(), null, "/api/v1/resources/" + resourceKey,
                                a.fileName(), a.mime(), a.size(), a.sha256(), a.createdAt(), resourceKey);
                    }
                    return new AttachmentData(a.id(), a.objectKey(), storage.signedUrl(a.objectKey()),
                            a.fileName(), a.mime(), a.size(), a.sha256(), a.createdAt(), null);
                })
                .toList();

        return new ReportDetailData(recordId, detail.reportNo(), record.title(),
                detail.reportType(), record.reportStatus(), detail.isDemo(), detail.demoNotice(),
                null, detail.institutionName(), detail.institutionType(), detail.departmentName(),
                detail.patientName(), detail.patientSex(), detail.patientAge(),
                detail.outpatientNo(), detail.inpatientNo(), detail.clinicalDiagnosis(),
                detail.applicantDoctor(), detail.specimenType(), detail.specimenNo(),
                detail.collectionAt(), detail.receivedAt(), detail.testedAt(), detail.reportedAt(),
                detail.operatorName(), detail.reviewerName(), detail.inspectionMethod(),
                detail.instrumentModel(), detail.sourceSystem(), detail.externalReportId(),
                detail.examRequestNo(), detail.referenceRangeNote(), detail.findingsText(),
                detail.impressionText(), detail.conclusionText(), detail.recommendationText(),
                sectionData, files);
    }

    private static String statusNotice(String status) {
        return switch (status == null ? "" : status) {
            case "REVIEWING" -> "报告待审核，检查结果暂不展示";
            case "PENDING" -> "报告待出结果，检查结果暂不展示";
            default -> "报告尚未出具，检查结果暂不展示";
        };
    }

    private static String truncate(String value, int max) {
        return value.length() <= max ? value : value.substring(0, max) + "…";
    }

    /** 报告标题里的状态后缀在 READY 后必须去掉，否则“待审核”标题 + 已出具消息自相矛盾。 */
    private static String stripStatusSuffix(String title) {
        return title.replace("（待审核）", "").replace("（待出结果）", "").trim();
    }

    /**
     * P0-3 报告发布：REVIEWING/PENDING → READY，并在同一事务内写 1 条站内消息。
     *
     * <p>幂等：同一 recordId 只允许 1 条 REPORT_READY 消息（bizKey=REPORT_READY:{recordId}）；
     * 重复调用返回 messageCreated=false，不重复打扰。已 READY 的档案按幂等成功处理，
     * 但只有 READY 才允许；NULL/其它状态一律 422，不把"状态未知"当"已出具"。</p>
     *
     * <p>内容边界：消息只描述"报告已出具"这一服务端事实，不写异常项、不写结论，
     * 避免未审核结果经消息提前泄露；演示报告标题带"（演示）"且有演示正文。</p>
     */
    @Transactional
    public ReportReadyData publishReady(String userId, String recordId) {
        var record = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "检查报告不存在"));
        if (!"EXAM".equals(record.category())) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "只有检查报告类档案可发布");
        }
        var detail = reports.findDetail(userId, recordId)
                .orElseThrow(() -> new ApiException("REPORT_DETAIL_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "该档案暂无电子检查报告明细"));

        Instant now = clock.instant();
        boolean changed = reports.markReady(userId, recordId, now);
        if (!changed) {
            // 并发或重复调用：重新读状态。已 READY 视为幂等成功，其它状态（含 NULL）拒绝。
            var latest = healthRecords.findById(userId, recordId)
                    .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "检查报告不存在"));
            if (!"READY".equals(latest.reportStatus())) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "当前报告状态不可发布（仅 PENDING/REVIEWING 可置 READY）");
            }
            record = latest;
        }
        Instant reportedAt = detail.reportedAt() != null ? detail.reportedAt()
                : (changed ? now : null);

        boolean messageCreated = false;
        if (notifyEnabled) {
            boolean demo = Boolean.TRUE.equals(detail.isDemo());
            String reportTitle = record.title() == null || record.title().isBlank()
                    ? "检查报告" : stripStatusSuffix(record.title().trim());
            String messageTitle = demo ? "检查报告已出具（演示）" : "检查报告已出具";
            String messageBody = "您的《" + truncate(reportTitle, 40) + "》报告已出具，"
                    + "可在“健康档案-检查报告”查看。"
                    + (demo ? "演示数据，非真实医疗报告。" : "本消息为系统提醒，不构成诊断建议。");
            messageCreated = messages.notifyOnce(userId, MessageService.TYPE_REPORT_READY,
                    messageTitle, messageBody, "report", recordId, "REPORT_READY:" + recordId);
        }
        return new ReportReadyData(recordId, detail.reportNo(), "READY", reportedAt,
                detail.isDemo(), messageCreated);
    }
}
