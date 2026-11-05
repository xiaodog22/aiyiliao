package com.wechar.biz.patient;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.patient.dto.ReportDetailData;
import com.wechar.biz.patient.dto.ReportSummaryData;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * V27 电子检查报告只读接口（契约路径 GET /api/v1/reports、/reports/{recordId}）。
 * 独立控制器，避免改动 PatientController 构造签名与既有测试。
 *
 * 权限：userId 只取当前会话（AuthService.ensureUser），所有查询强制带 user_id；
 * 非 READY 报告的明细门禁在 HealthReportService，前端隐藏不作为隔离手段。
 */
@RestController
@RequestMapping("/api/v1")
public class HealthReportController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;

    private final HealthReportService reports;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public HealthReportController(HealthReportService reports, AuthService authService,
                                  CurrentUserContext currentUserContext) {
        this.reports = reports;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    private String userId() {
        return authService.ensureUser(currentUserContext.currentUserId());
    }

    /** 报告列表：默认按报告时间倒序；from/to 为 yyyy-MM-dd（UTC 口径），to 不含当日边界。 */
    @GetMapping("/reports")
    public ResponseEntity<Envelope<List<ReportSummaryData>>> listReports(
            @RequestParam(required = false) String reportType,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String familyMemberId,
            @RequestParam(required = false) String from,
            @RequestParam(required = false) String to,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                reports.listReports(userId(), reportType, status, familyMemberId, from, to, bounded)));
    }

    /** 报告详情：越权 404；无明细 404；未 READY 返回脱敏结构（200 + statusNotice）。 */
    @GetMapping("/reports/{recordId}")
    public ResponseEntity<Envelope<ReportDetailData>> getReport(@PathVariable String recordId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), reports.getReport(userId(), recordId)));
    }
}
