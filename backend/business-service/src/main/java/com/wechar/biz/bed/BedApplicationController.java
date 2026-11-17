package com.wechar.biz.bed;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.bed.dto.BedApplicationData;
import com.wechar.biz.bed.dto.BedApplicationRequest;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 床位申请（申请制，2026-11-15）。
 *
 *   GET  /api/v1/beds/applications        我的申请（按登录医生的任职关系过滤）
 *   POST /api/v1/beds/applications        提交申请（Idempotency-Key 必填；患者用 appointmentId 或 patientRef 指定）
 *
 * ⚠️ 路径刻意与 {@link BedController} 的 /api/v1/beds 分开挂：
 *    字面量段 applications 优先于 {bedId} 变量段，不存在路由歧义。
 * ⚠️ 审批不在本控制器：由病区护士站/住院处执行（dev 演示见 DevBedApplicationController）。
 */
@RestController
@RequestMapping("/api/v1/beds/applications")
public class BedApplicationController {

    private final BedApplicationService applicationService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public BedApplicationController(BedApplicationService applicationService,
                                    AuthService authService,
                                    CurrentUserContext currentUserContext) {
        this.applicationService = applicationService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<BedApplicationData>>> list(
            @RequestParam(required = false) String status) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                applicationService.listMine(userId, status)));
    }

    @PostMapping
    public ResponseEntity<Envelope<BedApplicationData>> submit(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody BedApplicationRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                applicationService.submit(userId, key, request)));
    }
}
