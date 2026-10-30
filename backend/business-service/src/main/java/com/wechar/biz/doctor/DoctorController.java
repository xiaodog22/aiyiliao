package com.wechar.biz.doctor;

import com.wechar.biz.appointment.dto.AppointmentData;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.auth.dto.SessionData;
import com.wechar.biz.auth.dto.WechatLoginRequest;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.consultation.ConsultationService;
import com.wechar.biz.consultation.dto.DoctorConsultationData;
import com.wechar.biz.consultation.dto.MessageData;
import com.wechar.biz.doctor.dto.AppointmentStatusUpdateRequest;
import com.wechar.biz.doctor.dto.DoctorAccountLoginRequest;
import com.wechar.biz.doctor.dto.DoctorOverviewData;
import com.wechar.biz.doctor.dto.DoctorProfileData;
import com.wechar.biz.doctor.dto.DoctorTodoData;
import com.wechar.biz.doctor.dto.DoctorWorkbenchData;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * doctor 域控制器（M3 契约路径）：
 *  POST /api/v1/doctor/login（x-idempotency: not-required；X-Client-Version/X-Platform 必填）
 *  POST /api/v1/doctor/login-by-account（N8；Idempotency-Key + X-Client-Version/X-Platform 必填）
 *  GET  /api/v1/doctor/workbench
 *  GET  /api/v1/doctor/me（V21 医生自述资料：科室/职称/工号）
 *  GET  /api/v1/doctor/appointments（status?/date?/cursor?/limit?）
 *  POST /api/v1/doctor/appointments/{appointmentId}/status（Idempotency-Key 必填）
 *  GET  /api/v1/doctor/consultations（V21 医生问诊会话列表，cursor 游标分页；供医生端回复页消费）
 * 无医生任职 → 403；范围裁剪一律在服务层按登录账号的任职关系完成，不接受客户端传入范围参数。
 */
@RestController
@RequestMapping("/api/v1/doctor")
public class DoctorController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int PATH_ID_MAX = 64;

    private final DoctorService doctorService;
    private final ConsultationService consultationService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public DoctorController(DoctorService doctorService, ConsultationService consultationService,
                            AuthService authService, CurrentUserContext currentUserContext) {
        this.doctorService = doctorService;
        this.consultationService = consultationService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    /** 契约 doctorLogin：与患者登录同一套令牌机制；X-Platform 非 const 值 → 422。 */
    @PostMapping("/login")
    public ResponseEntity<Envelope<SessionData>> login(
            @RequestHeader(value = "X-Client-Version", required = true) String clientVersion,
            @RequestHeader(value = "X-Platform", required = true) String platform,
            @Valid @RequestBody WechatLoginRequest request) {
        if (!"wechat-miniprogram".equals(platform)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "X-Platform 仅接受 wechat-miniprogram（契约 const）");
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), doctorService.login(request)));
    }

    @GetMapping("/workbench")
    public ResponseEntity<Envelope<DoctorWorkbenchData>> workbench() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), doctorService.workbench(userId)));
    }

    /**
     * V21 契约 getDoctorProfile（GET /api/v1/doctor/me）：医生自述资料
     * （科室/职称/工号）。非医生 → 403；字段来自任职行，employeeNo 未登记则省略。
     */
    @GetMapping("/me")
    public ResponseEntity<Envelope<DoctorProfileData>> me() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), doctorService.profile(userId)));
    }

    /**
     * 契约 doctorLoginByAccount（N8，2026-10-19）：工号/手机号 + 短信验证码登录。
     * X-Client-Version/X-Platform required 头缺失 → 400；Platform 非 const → 422；
     * Idempotency-Key 必填（契约参数 required）→ 缺失 400。
     */
    @PostMapping("/login-by-account")
    public ResponseEntity<Envelope<SessionData>> loginByAccount(
            @RequestHeader(value = "X-Client-Version", required = true) String clientVersion,
            @RequestHeader(value = "X-Platform", required = true) String platform,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestBody DoctorAccountLoginRequest request) {
        if (!"wechat-miniprogram".equals(platform)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "X-Platform 仅接受 wechat-miniprogram（契约 const）");
        }
        IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), doctorService.loginByAccount(request)));
    }

    /** 契约 listDoctorTodos（N3，2026-10-19）：医生待处理事项；非医生 → 403。 */
    @GetMapping("/todos")
    public ResponseEntity<Envelope<java.util.List<DoctorTodoData>>> todos() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), doctorService.todos(userId)));
    }

    /** 契约 getDoctorOverview（N18，2026-10-19）：统计骨架；非医生 → 403，子块降级为 null。 */
    @GetMapping("/overview")
    public ResponseEntity<Envelope<DoctorOverviewData>> overview() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), doctorService.overview(userId)));
    }

    /**
     * V21 医生问诊会话列表（新→旧，cursor 双键游标分页）：
     * 非医生 → 403；仅返回本医生名下 ACTIVE 会话 + 患者姓名/头像，供「在线问诊处理」页消费。
     */
    @GetMapping("/consultations")
    public ResponseEntity<Envelope<java.util.List<DoctorConsultationData>>> consultations(
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String doctorId = doctorService.requireDoctor(userId).id();
        int bounded = Math.min(Math.max(limit, 1), 50);
        Cursors.PageCursor page = decodeOptional(cursor);
        var rows = consultationService.listForDoctor(doctorId,
                page == null ? null : page.createdAt(), page == null ? null : page.id(), bounded);
        Cursors.ApiMeta meta = null;
        if (!rows.isEmpty() && rows.size() >= bounded) {
            var last = rows.get(rows.size() - 1);
            meta = new Cursors.ApiMeta(Cursors.encode(last.createdAt(), last.id()), null, null);
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), rows, meta));
    }

    /** 医生视角拉取会话消息（旧→新升序，cursor 游标分页）：归属医生才可见，他人 → 404。 */
    @GetMapping("/consultations/{consultationId}/messages")
    public ResponseEntity<Envelope<java.util.List<MessageData>>> consultationMessages(
            @PathVariable String consultationId,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String doctorId = doctorService.requireDoctor(userId).id();
        int bounded = Math.min(Math.max(limit, 1), 50);
        Cursors.PageCursor page = decodeOptional(cursor);
        var messages = consultationService.listMessagesByDoctor(doctorId, consultationId,
                page == null ? null : page.createdAt(), page == null ? null : page.id(), bounded);
        Cursors.ApiMeta meta = null;
        if (!messages.isEmpty() && messages.size() >= bounded) {
            var last = messages.get(messages.size() - 1);
            meta = new Cursors.ApiMeta(Cursors.encode(last.createdAt(), last.id()), null, null);
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), messages, meta));
    }

    /**
     * 医生认领未分配咨询（V21 分配闭环）：未分配 → 绑定本人；已归本人 → 幂等重放；
     * 已归他人 / 会话已结束 → 409。Idempotency-Key 必填（防并发双认领）。
     */
    @PostMapping("/consultations/{consultationId}/accept")
    public ResponseEntity<Envelope<ConsultationService.AcceptResult>> acceptConsultation(
            @PathVariable String consultationId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String doctorId = doctorService.requireDoctor(userId).id();
        var result = consultationService.accept(doctorId, consultationId);
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(result.replayed()))
                .body(Envelope.ok(RequestIds.current(), result));
    }

    /**
     * 医生结束在线问诊（V21 收口，2026-10-24）：status → CLOSED，写一条 system_notice 并通知患者。
     * 仅归属医生可结束；已结束 → 409 CONSULTATION_CLOSED；不存在 / 非本人 → 404（不泄露存在性）。
     * Idempotency-Key 必填（与 accept 同口径，防重复提交写多条系统提示）。
     */
    @PostMapping("/consultations/{consultationId}/close")
    public ResponseEntity<Envelope<ConsultationService.CloseResult>> closeConsultation(
            @PathVariable String consultationId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String doctorId = doctorService.requireDoctor(userId).id();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                consultationService.close(doctorId, consultationId)));
    }

    @GetMapping("/appointments")
    public ResponseEntity<Envelope<java.util.List<AppointmentData>>> appointments(
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String date,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        DoctorService.AppointmentPage page = doctorService.listAppointments(userId, status, date, cursor, limit);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), page.items(),
                new Cursors.ApiMeta(page.nextCursor(), null, null)));
    }

    @PostMapping("/appointments/{appointmentId}/status")
    public ResponseEntity<Envelope<AppointmentData>> updateStatus(
            @PathVariable String appointmentId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody AppointmentStatusUpdateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失 → 400（契约参数 required）
        if (appointmentId == null || appointmentId.isBlank() || appointmentId.length() > PATH_ID_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "appointmentId 长度须为 1~64 字符");
        }
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var result = doctorService.updateStatus(userId, appointmentId, key, request);
        // 幂等重放时与 care-plan / 预约创建 / 问诊创建一致回 Idempotency-Replayed: true（D1 统一）
        ResponseEntity.BodyBuilder ok = ResponseEntity.ok();
        if (result.replayed()) ok.header(IdempotencyKeys.REPLAY_HEADER, "true");
        return ok.body(Envelope.ok(RequestIds.current(), result.appointment()));
    }

    // ---------------------------------------------------------------- 内部

    /** cursor 长度上限 256（契约）；非法解码在 Cursors 内 422。 */
    private static Cursors.PageCursor decodeOptional(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        if (cursor.length() > 256) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "cursor 超过 256 字符上限");
        }
        return Cursors.decode(cursor);
    }
}
