package com.wechar.biz.patient;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * V27 电子检查报告数据访问。
 *
 * 权限口径：每条查询都带 user_id（当前登录用户），不凭 reportId / recordId 单独取数；
 * 详情/分组/项目还额外带 user_id 复合条件（与 V27 复合外键一致）。
 * 性能口径：列表 1 条 SQL，详情 1 + 分组 1 + 项目 1 + 附件 1，共 4 条，无 N+1；
 * items 一次按 report_detail_id 取回后在 Service 层按 section_id 归组。
 */
@Component
public class HealthReportRepository {

    private final JdbcTemplate jdbc;

    public HealthReportRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record SummaryRow(String recordId, String reportNo, String title, String reportType,
                             String institutionName, String departmentName, String patientName,
                             String reportStatus, String familyMemberId, Instant recordedAt,
                             Instant reportedAt, int abnormalCount, boolean isDemo) {
    }

    public record DetailRow(String id, String recordId, String userId, String reportNo,
                            String reportType, String institutionName, String institutionType,
                            String departmentName, String patientName, String patientSex,
                            String patientAge, String outpatientNo, String inpatientNo,
                            String clinicalDiagnosis, String applicantDoctor, String specimenType,
                            String specimenNo, Instant collectionAt, Instant receivedAt,
                            Instant testedAt, Instant reportedAt, String operatorName,
                            String reviewerName, String inspectionMethod, String instrumentModel,
                            String findingsText, String impressionText, String conclusionText,
                            String recommendationText, boolean isDemo, String demoNotice) {
    }

    public record SectionRow(String id, String sectionCode, String sectionName, int sortOrder) {
    }

    public record ItemRow(String id, String sectionId, String itemCode, String itemName,
                          BigDecimal resultValue, String resultText, String unit,
                          BigDecimal referenceLow, BigDecimal referenceHigh, String referenceText,
                          String abnormalFlag, String inspectionMethod, String remark,
                          int sortOrder) {
    }

    private static Instant instant(Timestamp ts) {
        return ts == null ? null : ts.toInstant();
    }

    private static boolean bool(Object raw) {
        if (raw == null) {
            return false;
        }
        if (raw instanceof Boolean b) {
            return b;
        }
        return ((Number) raw).intValue() != 0;
    }

    private static int number(Object raw) {
        return raw == null ? 0 : ((Number) raw).intValue();
    }

    /** 报告列表：动态拼接固定条件片段，值一律参数化（不接受客户端拼 SQL）。 */
    public List<SummaryRow> listSummaries(String userId, String reportType, String status,
                                          String familyMemberId, Instant from, Instant to,
                                          int limit) {
        StringBuilder sql = new StringBuilder("""
                SELECT r.id AS record_id, d.report_no, r.title, d.report_type,
                       mi.institution_name, d.department_name_snapshot,
                       d.patient_name_snapshot, r.report_status, r.family_member_id,
                       r.recorded_at, d.reported_at, d.is_demo,
                       (SELECT COUNT(*) FROM health_report_items i
                         WHERE i.report_detail_id = d.id
                           AND i.abnormal_flag NOT IN ('NORMAL', 'NOT_APPLICABLE')) AS abnormal_count
                  FROM health_records r
                  JOIN health_report_details d ON d.record_id = r.id AND d.user_id = r.user_id
                  LEFT JOIN medical_institutions mi ON mi.id = d.institution_id
                 WHERE r.user_id = ?
                """);
        List<Object> args = new ArrayList<>();
        args.add(userId);
        if (reportType != null && !reportType.isBlank()) {
            sql.append(" AND d.report_type = ?");
            args.add(reportType);
        }
        if (status != null && !status.isBlank()) {
            sql.append(" AND r.report_status = ?");
            args.add(status);
        }
        if (familyMemberId != null && !familyMemberId.isBlank()) {
            sql.append(" AND r.family_member_id = ?");
            args.add(familyMemberId);
        }
        if (from != null) {
            sql.append(" AND r.recorded_at >= ?");
            args.add(Timestamp.from(from));
        }
        if (to != null) {
            sql.append(" AND r.recorded_at < ?");
            args.add(Timestamp.from(to));
        }
        sql.append(" ORDER BY COALESCE(d.reported_at, r.recorded_at) DESC, r.id DESC LIMIT ?");
        args.add(limit);

        return jdbc.query(sql.toString(), (rs, i) -> new SummaryRow(
                rs.getString("record_id"), rs.getString("report_no"), rs.getString("title"),
                rs.getString("report_type"), rs.getString("institution_name"),
                rs.getString("department_name_snapshot"), rs.getString("patient_name_snapshot"),
                rs.getString("report_status"), rs.getString("family_member_id"),
                instant(rs.getTimestamp("recorded_at")), instant(rs.getTimestamp("reported_at")),
                number(rs.getObject("abnormal_count")), bool(rs.getObject("is_demo"))),
                args.toArray());
    }

    /** 报告详情：user_id 与 record_id 同时匹配，越权一律视为不存在。 */
    public Optional<DetailRow> findDetail(String userId, String recordId) {
        return jdbc.query("""
                SELECT d.id, d.record_id, d.user_id, d.report_no, d.report_type,
                       mi.institution_name, mi.institution_type, d.department_name_snapshot,
                       d.patient_name_snapshot, d.patient_sex_snapshot, d.patient_age_snapshot,
                       d.outpatient_no, d.inpatient_no, d.clinical_diagnosis, d.applicant_doctor,
                       d.specimen_type, d.specimen_no, d.collection_at, d.received_at,
                       d.tested_at, d.reported_at, d.operator_name, d.reviewer_name,
                       d.inspection_method, d.instrument_model, d.findings_text,
                       d.impression_text, d.conclusion_text, d.recommendation_text,
                       d.is_demo, d.demo_notice
                  FROM health_report_details d
                  LEFT JOIN medical_institutions mi ON mi.id = d.institution_id
                 WHERE d.record_id = ? AND d.user_id = ?
                """, (rs, i) -> new DetailRow(
                rs.getString("id"), rs.getString("record_id"), rs.getString("user_id"),
                rs.getString("report_no"), rs.getString("report_type"),
                rs.getString("institution_name"), rs.getString("institution_type"),
                rs.getString("department_name_snapshot"), rs.getString("patient_name_snapshot"),
                rs.getString("patient_sex_snapshot"), rs.getString("patient_age_snapshot"),
                rs.getString("outpatient_no"), rs.getString("inpatient_no"),
                rs.getString("clinical_diagnosis"), rs.getString("applicant_doctor"),
                rs.getString("specimen_type"), rs.getString("specimen_no"),
                instant(rs.getTimestamp("collection_at")), instant(rs.getTimestamp("received_at")),
                instant(rs.getTimestamp("tested_at")), instant(rs.getTimestamp("reported_at")),
                rs.getString("operator_name"), rs.getString("reviewer_name"),
                rs.getString("inspection_method"), rs.getString("instrument_model"),
                rs.getString("findings_text"), rs.getString("impression_text"),
                rs.getString("conclusion_text"), rs.getString("recommendation_text"),
                bool(rs.getObject("is_demo")), rs.getString("demo_notice")),
                recordId, userId).stream().findFirst();
    }

    public List<SectionRow> listSections(String detailId, String userId) {
        return jdbc.query("""
                SELECT id, section_code, section_name, sort_order
                  FROM health_report_sections
                 WHERE report_detail_id = ? AND user_id = ?
                 ORDER BY sort_order, id
                """, (rs, i) -> new SectionRow(rs.getString("id"), rs.getString("section_code"),
                rs.getString("section_name"), rs.getInt("sort_order")), detailId, userId);
    }

    /** 一次取回整份报告的项目，Service 按 section_id 归组，避免逐分组查询。 */
    public List<ItemRow> listItems(String detailId, String userId) {
        return jdbc.query("""
                SELECT id, section_id, item_code, item_name, result_value, result_text, unit,
                       reference_low, reference_high, reference_text, abnormal_flag,
                       inspection_method, remark, sort_order
                  FROM health_report_items
                 WHERE report_detail_id = ? AND user_id = ?
                 ORDER BY sort_order, id
                """, (rs, i) -> new ItemRow(rs.getString("id"), rs.getString("section_id"),
                rs.getString("item_code"), rs.getString("item_name"),
                rs.getBigDecimal("result_value"), rs.getString("result_text"), rs.getString("unit"),
                rs.getBigDecimal("reference_low"), rs.getBigDecimal("reference_high"),
                rs.getString("reference_text"), rs.getString("abnormal_flag"),
                rs.getString("inspection_method"), rs.getString("remark"), rs.getInt("sort_order")),
                detailId, userId);
    }
}
