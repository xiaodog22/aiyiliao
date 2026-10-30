package com.wechar.biz.appointment;

import com.wechar.biz.appointment.dto.AppointmentCreateRequest;
import com.wechar.biz.appointment.dto.AppointmentData;
import com.wechar.biz.appointment.dto.AppointmentStatsData;
import com.wechar.biz.appointment.dto.AppointmentUpdateRequest;
import com.wechar.biz.appointment.dto.CreateResult;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.dao.ConcurrencyFailureException;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * appointment 控制器（M1.4，契约对齐）：
 *  POST /api/v1/appointments（Idempotency-Key 必填）
 *  PATCH /api/v1/appointments/{appointmentId}（version 乐观锁；契约外补充，README 已标注）
 *  GET  /api/v1/appointments/me（契约：status?/cursor?/limit?，服务端身份范围过滤——
 *       无裸 GET /api/v1/appointments，已按复核要求改名 /me）
 *  GET  /api/v1/appointments/by-idempotency-key/{key}（8~128，仅当前用户，无则 404）
 *  POST /api/v1/appointments/{appointmentId}/cancel（body {reason?} 可选、Idempotency-Key 必填，
 *       重复取消同终态 200）
 *  DELETE /api/v1/appointments/{appointmentId}（V21 患者取消 REST 形态，与 cancel 同一服务逻辑）
 *  GET  /api/v1/appointments/stats（契约暂无此路径，README 标注"契约外补充"）
 */
@RestController
@RequestMapping("/api/v1/appointments")
public class AppointmentController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;
    private static final int KEY_MIN = 8;
    private static final int KEY_MAX = 128;

    private final AppointmentService appointmentService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public AppointmentController(AppointmentService appointmentService, AuthService authService,
                                 CurrentUserContext currentUserContext) {
        this.appointmentService = appointmentService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @PostMapping
    public ResponseEntity<Envelope<AppointmentData>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody AppointmentCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失 → 400
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var result = createWithRaceFallback(userId, key, request);
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(result.replayed()))
                .body(Envelope.ok(RequestIds.current(), result.appointment()));
    }

    /**
     * 幂等创建 + 并发兜底（M4.6）：同键并发双发时撞 uk_appointments_idem 的请求
     * 不得 5xx——先读已提交同键行转重放/409；键尚不可见（H2/MySQL 死锁全员回滚）
     * 则整体重试一次（新事务，键此时已可见 → (a) 命中重放）。
     */
    private CreateResult createWithRaceFallback(String userId, String key,
                                                AppointmentCreateRequest request) {
        try {
            return appointmentService.create(userId, key, request);
        } catch (DataIntegrityViolationException | ConcurrencyFailureException e) {
            CreateResult replayed = appointmentService.replaySameKey(userId, key, request);
            if (replayed != null) {
                return replayed;
            }
            return appointmentService.create(userId, key, request);
        }
    }

    @PatchMapping("/{appointmentId}")
    public ResponseEntity<Envelope<AppointmentData>> patch(
            @PathVariable String appointmentId,
            @Valid @RequestBody AppointmentUpdateRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                appointmentService.patch(appointmentId, request)));
    }

    /**
     * 契约 GET /api/v1/appointments/me：服务端身份范围过滤发生在 SQL 条件内
     * （user_id = ?），不接受客户端传 userId/patientId。cursor 为契约参数（M1 列表量小，
     * 先接受并按 limit 截断；游标语义在 M2 分页任务展开）。
     */
    @GetMapping("/me")
    public ResponseEntity<Envelope<List<AppointmentData>>> listMine(
            @RequestParam(required = false) String status,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                appointmentService.list(userId, status, bounded)));
    }

    /**
     * 契约 GET /api/v1/appointments/by-idempotency-key/{key}：键 8~128；
     * 只返回当前用户在该键下的记录（越权/不存在一律 404，键不构成读取凭证）。
     */
    @GetMapping("/by-idempotency-key/{key}")
    public ResponseEntity<Envelope<AppointmentData>> byIdempotencyKey(@PathVariable String key) {
        String normalized = requireKeyLength(key);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                appointmentService.findByIdempotencyKey(userId, normalized)));
    }

    /**
     * 契约 POST /api/v1/appointments/{appointmentId}/cancel：
     * body 可选 {reason?}；Idempotency-Key 必填；仅当前用户资源（他人 404）；
     * 已处于 CANCELLED 等终态 → 200 同终态（不报错）；不可取消状态 → 409。
     */
    @PostMapping("/{appointmentId}/cancel")
    public ResponseEntity<Envelope<AppointmentData>> cancel(
            @PathVariable String appointmentId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestBody(required = false) CancelRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String reason = request == null ? null : request.reason();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                appointmentService.cancel(userId, appointmentId, key, reason)));
    }

    /**
     * V21（2026-10-21）DELETE /api/v1/appointments/{appointmentId}：患者取消预约的
     * REST 语义形态，与 POST /{id}/cancel **同一服务逻辑**（终态重复取消 200、
     * 取消成功回补号源）。不必填 Idempotency-Key——取消结果确定（同一终态），
     * 重复调用天然幂等；reason 经 query 传递（≤200）。
     * 仅当前用户资源（他人/不存在 → 404，不泄露存在性）。
     */
    @DeleteMapping("/{appointmentId}")
    public ResponseEntity<Envelope<AppointmentData>> delete(
            @PathVariable String appointmentId,
            @RequestParam(required = false) String reason) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String key = "del-" + appointmentId; // 仅服务内占位：cancel 不按键重放，只按终态判定
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                appointmentService.cancel(userId, appointmentId, key, reason)));
    }

    /**
     * 契约外补充 GET /api/v1/appointments/stats（契约 /appointments 仅 POST、/me 为列表）；
     * 前端 api.js 未调用，保留任务书统计能力，README 标注"契约外补充"。
     */
    @GetMapping("/stats")
    public ResponseEntity<Envelope<AppointmentStatsData>> stats() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), appointmentService.stats(userId)));
    }

    /** 契约 path key：minLength 8 / maxLength 128，越界 → 422 VALIDATION_FAILED。 */
    private static String requireKeyLength(String key) {
        if (key == null || key.length() < KEY_MIN || key.length() > KEY_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "幂等键长度须为 8~128 字符");
        }
        return key;
    }

    /** 契约 cancel requestBody：object，properties.reason ≤200，非必填（可空 body）。 */
    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
    public record CancelRequest(String reason) {
    }
}
