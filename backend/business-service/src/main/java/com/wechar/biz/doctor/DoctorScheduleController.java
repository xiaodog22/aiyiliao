package com.wechar.biz.doctor;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.doctor.dto.DoctorAvailabilityData;
import com.wechar.biz.doctor.dto.DoctorOnlineStatusData;
import com.wechar.biz.doctor.dto.DoctorOnlineStatusUpdateRequest;
import com.wechar.biz.doctor.dto.DoctorScheduleData;
import com.wechar.biz.doctor.dto.DoctorScheduleUpdateRequest;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

/**
 * 排班与在线接诊控制器（V22，2026-10-22；此前是纯占位，契约与代码都没有）。
 *
 *  GET  /api/v1/doctor/schedule                    医生本人周模板 + 在线状态（403 非医生）
 *  PUT  /api/v1/doctor/schedule                    整体替换周模板（Idempotency-Key 必填；409 版本冲突）
 *  POST /api/v1/doctor/online-status               开关在线接诊（Idempotency-Key 必填；409 仍有待回复问诊）
 *  GET  /api/v1/doctors/{doctorId}/availability     患者侧只读（公开，与 /slots 同口径）
 *
 * 身份范围：医生端三个端点一律以服务端任职关系（doctors.user_id + status=ACTIVE）为准，
 * 不接受客户端传 doctorId 冒充；患者侧 availability 只读展示，不泄露排班明细。
 */
@RestController
public class DoctorScheduleController {

    private static final int PATH_ID_MAX = 64;

    private final DoctorScheduleService scheduleService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public DoctorScheduleController(DoctorScheduleService scheduleService, AuthService authService,
                                    CurrentUserContext currentUserContext) {
        this.scheduleService = scheduleService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping("/api/v1/doctor/schedule")
    public ResponseEntity<Envelope<DoctorScheduleData>> getSchedule() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), scheduleService.schedule(userId)));
    }

    @PutMapping("/api/v1/doctor/schedule")
    public ResponseEntity<Envelope<DoctorScheduleData>> replaceSchedule(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody DoctorScheduleUpdateRequest request) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var result = scheduleService.replaceSchedule(userId, request);
        ResponseEntity.BodyBuilder ok = ResponseEntity.ok();
        if (result.replayed()) {
            ok.header(IdempotencyKeys.REPLAY_HEADER, "true");
        }
        return ok.body(Envelope.ok(RequestIds.current(), result.schedule()));
    }

    @PostMapping("/api/v1/doctor/online-status")
    public ResponseEntity<Envelope<DoctorOnlineStatusData>> onlineStatus(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody DoctorOnlineStatusUpdateRequest request) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                scheduleService.setOnline(userId, Boolean.TRUE.equals(request.online()))));
    }

    /** 患者侧只读（公开）：未开局 → online/accepting 双 false，nextSlotAt 可能为 null。 */
    @GetMapping("/api/v1/doctors/{doctorId}/availability")
    public ResponseEntity<Envelope<DoctorAvailabilityData>> availability(@PathVariable String doctorId) {
        if (doctorId == null || doctorId.isBlank() || doctorId.length() > PATH_ID_MAX) {
            // 与其它路径参数同一口径：越界走全局异常处理 → 422 统一信封
            throw new com.wechar.biz.common.ApiException("VALIDATION_FAILED",
                    org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                    "doctorId 长度须为 1~64 字符");
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), scheduleService.availability(doctorId)));
    }
}
