package com.wechar.biz.consultation;

import com.wechar.biz.ai.AiTaskService;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.common.Cursors.ApiMeta;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.consultation.dto.ConsultationCreateRequest;
import com.wechar.biz.consultation.dto.ConsultationData;
import com.wechar.biz.consultation.dto.DoctorReplyRequest;
import com.wechar.biz.consultation.dto.InputConfirmationRequest;
import com.wechar.biz.consultation.dto.MessageCreateRequest;
import com.wechar.biz.consultation.dto.MessageData;
import com.wechar.biz.doctor.DoctorService;
import jakarta.validation.Valid;
import java.util.List;
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
 * 问诊会话控制器（M2.1，契约 /api/v1/consultations 域）：
 *  GET    /api/v1/consultations                      列表（游标分页，元数据+摘要，不含正文）
 *  POST   /api/v1/consultations                      创建（Idempotency-Key 必填；急症优先不阻塞）
 *  GET    /api/v1/consultations/{id}                 详情与消息（游标分页）
 *  POST   /api/v1/consultations/{id}/messages        发送消息（Idempotency-Key 必填；先落库再建任务）
 *  POST   /api/v1/consultations/{id}/confirmations   确认转写（Idempotency-Key 必填；确认后终止源任务）
 * 身份范围过滤在服务端 SQL 条件内，不接受客户端传 userId；他人资源一律 404。
 */
@RestController
@RequestMapping("/api/v1/consultations")
public class ConsultationController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;
    private static final int CURSOR_MAX = 256;

    private final ConsultationService consultationService;
    private final AuthService authService;
    private final DoctorService doctorService;
    private final CurrentUserContext currentUserContext;

    public ConsultationController(ConsultationService consultationService, AuthService authService,
                                  DoctorService doctorService, CurrentUserContext currentUserContext) {
        this.consultationService = consultationService;
        this.authService = authService;
        this.doctorService = doctorService;
        this.currentUserContext = currentUserContext;
    }

    /** 我的问诊会话（列表只给元数据与摘要，正文按会话单独拉取）。 */
    @GetMapping
    public ResponseEntity<Envelope<List<ConsultationData>>> list(
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        Cursors.PageCursor page = decodeOptional(cursor);
        List<ConsultationData> rows = consultationService.list(userId,
                page == null ? null : page.createdAt(), page == null ? null : page.id(), bounded);
        ApiMeta meta = null;
        if (!rows.isEmpty() && rows.size() >= bounded) {
            var last = rows.get(rows.size() - 1);
            meta = new ApiMeta(Cursors.encode(last.createdAt(), last.id()), null, null);
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), rows, meta));
    }

    /** 创建问诊会话并发起首个 AI 任务（急症命中先回 safety.emergency=true，不阻塞生成）。 */
    @PostMapping
    public ResponseEntity<Envelope<ConsultationService.ConsultationCreated>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody ConsultationCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var created = consultationService.create(userId, key, request);
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(created.replayed()))
                .body(Envelope.ok(RequestIds.current(), created));
    }

    /** 会话详情与消息（cursor 之后的消息，旧→新方向）。 */
    @GetMapping("/{consultationId}")
    public ResponseEntity<Envelope<ConsultationService.ConsultationDetail>> get(
            @PathVariable String consultationId,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        Cursors.PageCursor page = decodeOptional(cursor);
        var detail = consultationService.get(userId, consultationId,
                page == null ? null : page.createdAt(), page == null ? null : page.id(), bounded);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), detail));
    }

    /** 拉取会话消息正文（N1，2026-10-19 补齐）：旧→新升序，游标分页；不存在/越权 → 404。 */
    @GetMapping("/{consultationId}/messages")
    public ResponseEntity<Envelope<List<MessageData>>> listMessages(
            @PathVariable String consultationId,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        Cursors.PageCursor page = decodeOptional(cursor);
        var result = consultationService.listMessages(userId, consultationId,
                page == null ? null : page.createdAt(), page == null ? null : page.id(), bounded);
        ApiMeta meta = result.nextCursor() == null ? null : new ApiMeta(result.nextCursor(), null, null);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), result.messages(), meta));
    }

    /** 发送消息（先落库再建任务；生成失败不影响消息持久化）。 */
    @PostMapping("/{consultationId}/messages")
    public ResponseEntity<Envelope<ConsultationService.MessageSent>> send(
            @PathVariable String consultationId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody MessageCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var sent = consultationService.send(userId, consultationId, key, request);
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(sent.replayed()))
                .body(Envelope.ok(RequestIds.current(), sent));
    }

    /** 确认转写/结构化输入（确认后终止源任务后续生成）。 */
    @PostMapping("/{consultationId}/confirmations")
    public ResponseEntity<Envelope<MessageData>> confirm(
            @PathVariable String consultationId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody InputConfirmationRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var result = consultationService.confirm(userId, consultationId, key, request);
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(result.replayed()))
                .body(Envelope.ok(RequestIds.current(), result.message()));
    }

    /**
     * 医生回复问诊（V21 闭环，前端「在线问诊处理」入口）。
     * 医生鉴权：must be doctor + 会话归属（doctor_id == 本人）；他人/未分配 → 404 防探测。
     * 写操作：Idempotency-Key 必填；回复落库后同步写患者消息中心通知（未读红点）。
     */
    @PostMapping("/{consultationId}/doctor-reply")
    public ResponseEntity<Envelope<ConsultationService.DoctorReplySent>> doctorReply(
            @PathVariable String consultationId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody DoctorReplyRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String doctorUserId = authService.ensureUser(currentUserContext.currentUserId());
        String doctorId = doctorService.requireDoctor(doctorUserId).id();
        var sent = consultationService.doctorReply(doctorId, consultationId, key, request.content());
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(sent.replayed()))
                .body(Envelope.ok(RequestIds.current(), sent));
    }

    /**
     * AI 分诊建议（TRIAGE 任务，2026-10-24）：把会话内患者全部描述聚合成症状文本，
     * 交远端模型返回「科室 + 置信度 + 依据」。
     *
     * 语义：**只建任务、不同步等模型**（单并发 CPU 模型几十秒级，同步等会拖死网关）。
     * 客户端拿 data.taskId 后轮询 GET /api/v1/ai/tasks/{taskId}，SUCCEEDED 时读
     * data.result.recommendedDepartments[]（departmentName / reason / confidence）。
     *
     * 幂等：不写业务数据（只建任务），同会话 60s 内重复调用复用既有任务，故不要求 Idempotency-Key。
     * 越权：会话不属于当前用户 → 404（ownedConsultation）。
     */
    @PostMapping("/{consultationId}/triage")
    public ResponseEntity<Envelope<AiTaskService.AiTaskData>> triage(
            @PathVariable String consultationId,
            @RequestHeader(value = "X-Client-Version", required = false) String clientVersion,
            @RequestBody(required = false) java.util.Map<String, String> body) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String profile = body == null ? null : body.get("requestedProfile");
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                consultationService.recommendDepartment(userId, consultationId, profile)));
    }

    // ---------------------------------------------------------------- 内部

    /** cursor 长度上限 256（契约）；非法解码在 Cursors 内 422。 */
    private static Cursors.PageCursor decodeOptional(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return null;
        }
        if (cursor.length() > CURSOR_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "cursor 超过 256 字符上限");
        }
        return Cursors.decode(cursor);
    }
}
