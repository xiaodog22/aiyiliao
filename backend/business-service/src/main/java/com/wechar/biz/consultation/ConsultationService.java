package com.wechar.biz.consultation;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskService;
import com.wechar.biz.catalog.CatalogRepository;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.common.Digests;
import com.wechar.biz.consultation.dto.CitationData;
import com.wechar.biz.consultation.dto.ConsultationCreateRequest;
import com.wechar.biz.consultation.dto.ConsultationData;
import com.wechar.biz.consultation.dto.DoctorConsultationData;
import com.wechar.biz.consultation.dto.InputConfirmationRequest;
import com.wechar.biz.consultation.dto.MessageCreateRequest;
import com.wechar.biz.consultation.dto.MessageData;
import com.wechar.biz.message.MessageService;
import com.wechar.biz.triage.TriageRuleEngine;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 问诊会话服务（M2.1，契约 /consultations 域）：
 *  - 创建：急症优先——本地红旗规则先跑，命中即随响应返回 safety.emergency=true 且不阻塞生成；
 *  - 消息：用户消息先落库（权威记录在 MySQL），再创建 AI 任务；生成失败不影响消息持久化；
 *  - 确认：语音转写/识别结果进入诊疗流程前必须经用户核对；确认后终止源任务后续生成；
 *  - 身份范围过滤：consultation 归属 user_id 参与 SQL 条件，他人资源一律 404。
 */
@Service
public class ConsultationService {

    private static final Logger log = LoggerFactory.getLogger(ConsultationService.class);

    private final ConsultationRepository repository;
    private final AiTaskService aiTaskService;
    private final TriageRuleEngine triageRuleEngine;
    private final MessageService messageService;
    private final CatalogRepository catalogRepository;
    private final ObjectMapper mapper;
    private final Clock clock;

    public ConsultationService(ConsultationRepository repository, AiTaskService aiTaskService,
                               TriageRuleEngine triageRuleEngine, MessageService messageService,
                               CatalogRepository catalogRepository, ObjectMapper mapper, Clock clock) {
        this.repository = repository;
        this.aiTaskService = aiTaskService;
        this.triageRuleEngine = triageRuleEngine;
        this.messageService = messageService;
        this.catalogRepository = catalogRepository;
        this.mapper = mapper;
        this.clock = clock;
    }

    /** 创建结果（契约 data：consultation + task + safety）；replayed 用于 Idempotency-Replayed 头。 */
    public record ConsultationCreated(ConsultationData consultation, AiTaskService.AiTaskData task,
                                      SafetyData safety, boolean replayed) {
    }

    /** 契约 SafetyNotice（emergency/level 必填）。 */
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record SafetyData(Boolean emergency, String level, String message, String provenance,
                             String ruleSetVersion) {
    }

    // ---------------------------------------------------------------- 创建

    /**
     * 创建问诊会话。**故意不加 @Transactional**（契约红线）：
     * 会话+首条消息由 repository 的 REQUIRES_NEW 先行提交，再创建 AI 任务——
     * 上游失败（503）时消息仍持久化，客户端可看到自己发出的内容并重试生成；
     * 也保证急症 safety 提示不被生成失败拖累（契约 createConsultation 描述）。
     */
    public ConsultationCreated create(String userId, String idempotencyKey, ConsultationCreateRequest request) {
        String digest = Digests.sha256Hex(canonical(request.initialMessage(), request.inputMode(),
                request.requestedProfile(), request.locale(), request.doctorId()));
        Instant now = clock.instant();

        // V23 申请模式：患者指定医生 → 会话直接分配该医生（免认领）；医生不存在/停诊 → 404
        String doctorLoginUser = null;
        if (request.doctorId() != null && !request.doctorId().isBlank()) {
            doctorLoginUser = catalogRepository.findDoctorUserId(request.doctorId())
                    .orElseThrow(() -> new ApiException("DOCTOR_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "所选医生不存在或已停诊"));
        }

        // 幂等：同键同体重放 → 既有会话与任务；同键异体 → 409
        var existing = repository.findConsultationByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            var row = existing.get();
            if (!row.requestDigest().equals(digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键");
            }
            var latest = aiTaskService.findLatestForConsultation(row.id());
            if (latest.isPresent()) {
                return new ConsultationCreated(toData(row), aiTaskService.toData(latest.get()),
                        safetyFor(row.id()), true);
            }
            // 上次任务创建失败（如上游 503）：会话与首条消息已落库，同键重试即补建任务；
            // safety 用本地红旗规则重算，急症提示不因上次失败而丢失
            var taskRow = aiTaskService.create(userId, row.id(), "CHAT",
                    null, chatContext(row.id()), request.requestedProfile(), null, null);
            return new ConsultationCreated(toData(row), aiTaskService.toData(taskRow),
                    ruleSafety(request.initialMessage()), true);
        }

        // 急症优先：本地红旗规则先跑（不等模型；命中即随响应返回，不阻塞生成）
        SafetyData safety = ruleSafety(request.initialMessage());

        String consultationId = "cn-" + UUID.randomUUID();
        String title = request.initialMessage().length() > 30
                ? request.initialMessage().substring(0, 30) : request.initialMessage();

        // 首条用户消息（落库为权威记录）——独立事务先行提交，任务创建失败不回滚它
        String messageId = "msg-" + UUID.randomUUID();
        repository.persistConsultationWithInitialMessage(
                new ConsultationRepository.ConsultationRow(
                        consultationId, userId, request.doctorId(), title, "ACTIVE", null, now, idempotencyKey,
                        digest, now, null),
                new ConsultationRepository.MessageRow(
                        messageId, consultationId, userId, "user", "TEXT", request.initialMessage(),
                        "USER_INPUT", null, null, null, null, null, null, null, null, now));

        // V23 申请模式：向医生登录账号写 CONSULT_APPLY 消息（红点提示；失败不阻断创建）
        if (doctorLoginUser != null) {
            try {
                String bodyText = request.initialMessage().length() > 60
                        ? request.initialMessage().substring(0, 60) + "…" : request.initialMessage();
                messageService.notify(doctorLoginUser, MessageService.TYPE_CONSULT_APPLY,
                        "新的在线问诊申请",
                        "有患者向您发起在线问诊：" + bodyText,
                        "consultation", consultationId);
            } catch (Exception exc) {
                log.warn("医生问诊申请通知写入失败（不阻断创建）| consultation={} | error={}",
                        consultationId, exc.getClass().getSimpleName());
            }
        }

        // 创建 AI 任务（CHAT；inputInline = **多轮上下文**，由 D 侧执行器消费；上游失败 → 结构化 503 冒泡，
        // 但上面的会话与消息已提交，符合"生成失败不影响持久化"）
        var taskRow = aiTaskService.create(userId, consultationId, "CHAT",
                null, chatContext(consultationId), request.requestedProfile(), null, null);
        AiTaskService.AiTaskData task = aiTaskService.toData(taskRow);

        var row = repository.findConsultationById(consultationId).orElseThrow();
        return new ConsultationCreated(toData(row), task, safety, false);
    }

    // ---------------------------------------------------------------- 消息

    /**
     * 发送消息：**故意不加 @Transactional** —— 消息先经 REQUIRES_NEW 独立落库（权威），
     * 再建任务；生成失败不影响消息持久化（契约 sendConsultationMessage 明文要求）。
     */
    public MessageSent send(String userId, String consultationId, String idempotencyKey,
                            MessageCreateRequest request) {
        String digest = Digests.sha256Hex(canonical(request.content(), request.inputMode(),
                request.requestedProfile(), request.confirmedInputId()));
        Instant now = clock.instant();

        var consultation = ownedConsultation(userId, consultationId);
        requireWritable(consultation);

        // 幂等：同键同体 → 既有消息与任务；同键异体 → 409
        var existing = repository.findMessageByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            var msg = existing.get();
            if (!msg.requestDigest().equals(digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键");
            }
            var latest = aiTaskService.findLatestForConsultation(consultationId);
            if (latest.isPresent()) {
                return new MessageSent(toData(msg), aiTaskService.toData(latest.get()),
                        safetyFor(consultationId), true);
            }
            // 消息已落库但上次任务创建失败：同键重试即补建任务，safety 本地重算
            var taskRow = aiTaskService.create(userId, consultationId, "CHAT",
                    null, chatContext(consultationId), request.requestedProfile(), null, null);
            return new MessageSent(toData(msg), aiTaskService.toData(taskRow),
                    ruleSafety(request.content()), true);
        }

        // 急症优先：命中红线先给安全提示，不阻塞生成
        SafetyData safety = ruleSafety(request.content());

        String messageId = "msg-" + UUID.randomUUID();
        repository.persistMessageAndTouch(consultationId, now, now,
                new ConsultationRepository.MessageRow(
                        messageId, consultationId, userId, "user", "TEXT", request.content(),
                        "USER_INPUT", null, null, null, null, idempotencyKey, digest, null, null, now));

        var taskRow = aiTaskService.create(userId, consultationId, "CHAT",
                null, chatContext(consultationId), request.requestedProfile(), null, null);
        AiTaskService.AiTaskData task = aiTaskService.toData(taskRow);

        var msg = repository.findMessageById(messageId).orElseThrow();
        return new MessageSent(toData(msg), task, safety, false);
    }

    public record MessageSent(MessageData message, AiTaskService.AiTaskData task, SafetyData safety,
                              boolean replayed) {
    }

    // ---------------------------------------------------------------- 医生回复（V21 闭环）

    /** 医生回复结果；replayed 用于 Idempotency-Replayed 头。 */
    public record DoctorReplySent(MessageData message, boolean replayed) {
    }

    /**
     * 医生回复患者问诊。与 send 同构：消息先经 REQUIRES_NEW 独立落库（权威），
     * 再同步写患者消息中心通知（同事务，状态变更不出现"没通知"）。
     * 权限：必须是本会话归属医生（consultation.doctor_id == doctor.id，防探测 404）；
     * 会话已结束（非 ACTIVE）→ 409。幂等按 (consultationId, idempotencyKey) 判定。
     */
    public DoctorReplySent doctorReply(String doctorId, String consultationId, String idempotencyKey,
                                       String content) {
        Instant now = clock.instant();
        var consultation = repository.findConsultationById(consultationId)
                .orElseThrow(() -> new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND,
                        "咨询不存在或无权访问"));
        if (consultation.doctorId() == null || !consultation.doctorId().equals(doctorId)) {
            throw new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "咨询不存在或无权访问");
        }
        if (!"ACTIVE".equals(consultation.status())) {
            throw new ApiException("CONSULTATION_CLOSED", HttpStatus.CONFLICT, "该咨询已结束，无法回复");
        }

        String digest = Digests.sha256Hex(content);
        var existing = repository.findMessageByConsultationAndIdempotencyKey(consultationId, idempotencyKey);
        if (existing.isPresent()) {
            var msg = existing.get();
            if (!msg.requestDigest().equals(digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键");
            }
            return new DoctorReplySent(toData(msg), true);
        }

        String messageId = "msg-" + UUID.randomUUID();
        repository.persistMessageAndTouch(consultationId, now, now,
                new ConsultationRepository.MessageRow(
                        messageId, consultationId, consultation.userId(), "doctor", "TEXT", content,
                        "DOCTOR_REPLY", null, null, null, null, idempotencyKey, digest, null, null, now));

        // 患者消息中心：未读红点 + 跳转咨询会话
        messageService.notify(consultation.userId(), MessageService.TYPE_CONSULT_REPLY,
                "医生回复了您的问诊",
                content.length() > 80 ? content.substring(0, 80) : content,
                "consultation", consultationId);

        var msg = repository.findMessageById(messageId).orElseThrow();
        return new DoctorReplySent(toData(msg), false);
    }

    /** 医生视角会话列表（V21 归属 + 未分配认领池；assignedDoctorId 供前端区分认领/回复）。 */
    public List<DoctorConsultationData> listForDoctor(String doctorId,
                                                      Instant beforeCreatedAt, String beforeId, int limit) {
        return repository.listByDoctor(doctorId, beforeCreatedAt, beforeId, limit).stream()
                .map(row -> new DoctorConsultationData(
                        row.id(), row.title(), row.status(), row.lastMessageAt(),
                        repository.countMessages(row.id()), row.summary(), row.createdAt(),
                        row.patientName(), row.patientAvatarKey(), row.assignedDoctorId(),
                        // 接诊态与患者端医生卡同源：会话内已有医生侧消息（回复/接诊提示）
                        repository.hasNonUserMessage(row.id())))
                .toList();
    }

    /** 医生认领结果；replayed 用于 Idempotency-Replayed 头（重复认领本人会话 → 幂等重放）。 */
    public record AcceptResult(boolean replayed) {
    }

    /**
     * 医生认领未分配咨询（V21 分配闭环；Idempotency-Key 由控制器校验）。
     * 已归本人 → 幂等返回 true；归他人 → 409（防抢）；会话非 ACTIVE → 409。
     */
    public AcceptResult accept(String doctorId, String consultationId) {
        Instant now = clock.instant();
        var consultation = repository.findConsultationById(consultationId)
                .orElseThrow(() -> new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND,
                        "咨询不存在或无权访问"));
        if (!"ACTIVE".equals(consultation.status())) {
            throw new ApiException("CONSULTATION_CLOSED", HttpStatus.CONFLICT,
                    "该咨询已结束，无法接诊");
        }
        boolean replayed;
        if (consultation.doctorId() != null) {
            // 患者指定医生发起的会话交付即归属本人：此时「接诊」是显式开始，同样要落系统提示
            if (!consultation.doctorId().equals(doctorId)) {
                throw new ApiException("CONSULTATION_TAKEN", HttpStatus.CONFLICT,
                        "该咨询已被其他医生接诊");
            }
            replayed = true;
        } else {
            int updated = repository.acceptConsultation(consultationId, doctorId, now);
            if (updated != 1) {
                throw new ApiException("CONSULTATION_TAKEN", HttpStatus.CONFLICT,
                        "该咨询已被其他医生接诊");
            }
            replayed = false;
        }
        // 接诊即写入一条系统提示（role=system_notice），幂等条件：会话内还没有任何医生侧消息。
        //  ① 双方会话里都有「XX 医生已接诊」记录（对齐微信对话的系统胶囊观感）；
        //  ② 患者端 accepting 由「存在非患者侧消息」判定，因此接诊后立刻从「待接诊」变「正在接诊」，
        //     且不会因为患者随后再发言而回退；
        //  ③ 重复点「接诊」或已回复过的会话不会重复写。
        if (!repository.hasNonUserMessage(consultationId)) {
            String doctorName = repository.findDoctorBrief(doctorId)
                    .map(ConsultationRepository.DoctorBrief::name).orElse("");
            String notice = (doctorName.isEmpty() ? "医生" : doctorName) + "已接诊，正在为您解答";
            repository.persistMessageAndTouch(consultationId, now, now,
                    new ConsultationRepository.MessageRow(
                            "msg-" + UUID.randomUUID(), consultationId, consultation.userId(),
                            "system_notice", "TEXT", notice, "SYSTEM", null, null, null, null,
                            null, null, null, null, now));
            messageService.notify(consultation.userId(), MessageService.TYPE_CONSULT_REPLY,
                    "医生已接诊", notice, "consultation", consultationId);
        }
        return new AcceptResult(replayed);
    }

    /** 医生结束问诊结果；status 回显会话终态（前端据此锁输入、停轮询）。 */
    public record CloseResult(String status) {
    }

    /**
     * 医生结束本次问诊（V21 收口，2026-10-24）。
     *  - 不存在 / 非本人 → 404（与消息接口同口径，不泄露会话存在性）；
     *  - 已结束 → 409 CONSULTATION_CLOSED（不静默成功，避免「以为结束了其实没结束」）；
     *  - 成功：consultations.status = CLOSED + 一条 system_notice（双方可见）+ 患者消息中心通知。
     * 结束后患者再发消息由 send() 的 ACTIVE 校验拦成 409，不会产生孤儿消息。
     */
    public CloseResult close(String doctorId, String consultationId) {
        Instant now = clock.instant();
        var consultation = repository.findConsultationById(consultationId)
                .orElseThrow(() -> new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND,
                        "咨询不存在或无权访问"));
        if (consultation.doctorId() == null || !consultation.doctorId().equals(doctorId)) {
            throw new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "咨询不存在或无权访问");
        }
        if (!"ACTIVE".equals(consultation.status())) {
            throw new ApiException("CONSULTATION_CLOSED", HttpStatus.CONFLICT, "该咨询已结束");
        }
        int updated = repository.closeConsultation(consultationId, doctorId, now);
        if (updated != 1) {
            // 并发：另一个请求刚好也点了结束 → 终态一致，但仍按 409 告知调用方未由其本次置终态
            throw new ApiException("CONSULTATION_CLOSED", HttpStatus.CONFLICT, "该咨询已结束");
        }
        String notice = "医生已结束本次问诊，祝您早日康复。如需继续咨询请重新发起。";
        repository.persistMessageAndTouch(consultationId, now, now,
                new ConsultationRepository.MessageRow(
                        "msg-" + UUID.randomUUID(), consultationId, consultation.userId(),
                        "system_notice", "TEXT", notice, "SYSTEM", null, null, null, null,
                        null, null, null, null, now));
        messageService.notify(consultation.userId(), MessageService.TYPE_CONSULT_REPLY,
                "问诊已结束", notice, "consultation", consultationId);
        return new CloseResult("CLOSED");
    }

    /** 医生视角拉取会话消息（旧→新升序）：必须是本会话归属医生，否则 404 防探测。 */
    public List<MessageData> listMessagesByDoctor(String doctorId, String consultationId,
                                                  Instant afterCreatedAt, String afterId, int limit) {
        var consultation = repository.findConsultationById(consultationId)
                .orElseThrow(() -> new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND,
                        "咨询不存在或无权访问"));
        if (consultation.doctorId() == null || !consultation.doctorId().equals(doctorId)) {
            throw new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "咨询不存在或无权访问");
        }
        return repository.listMessages(consultationId, afterCreatedAt, afterId, limit).stream()
                .map(this::toData)
                .toList();
    }

    /** 本地红旗规则的 SafetyNotice（不等模型；创建/补建任务时用，保证急症优先）。 */
    private SafetyData ruleSafety(String text) {
        TriageRuleEngine.RuleOutcome outcome = triageRuleEngine.scanText(text);
        return new SafetyData(outcome.emergency(), outcome.level(),
                outcome.emergency()
                        ? "命中急症红旗：" + String.join("、", outcome.matchedRules()) + "。"
                                + TriageRuleEngine.emergencyAdvice()
                        : "未命中急症红线，AI 回复仅供参考，不构成诊断。",
                "RULE_RESULT", TriageRuleEngine.RULESET_VERSION);
    }

    // ---------------------------------------------------------------- 确认

    /**
     * 确认转写/结构化输入（契约 POST /confirmations）：
     *  - 未确认的转写只能作为草稿存在；确认后 generation_status=CONFIRMED，内容以用户核对文本为准；
     *  - 确认后终止源任务后续生成（取消上游任务，避免草稿文本被继续加工成结论）；
     *  - 幂等：同键同体重放 → 既有确认结果；同键异体 → 409。
     * **故意不加 @Transactional**：确认经 REQUIRES_NEW 先行提交，随后终止源任务若抛出
     * ApiException（上游不可达/任务不存在，已被 catch），不会把外层事务标记 rollback-only
     * 而导致确认连带回滚（UnexpectedRollbackException → 500 且用户核对结果丢失）。
     */
    public InputConfirmed confirm(String userId, String consultationId, String idempotencyKey,
                                  InputConfirmationRequest request) {
        String digest = Digests.sha256Hex(canonical(request.sourceTaskId(), request.confirmedText(),
                request.corrections() == null ? "" : String.join(",", request.corrections())));
        requireWritable(ownedConsultation(userId, consultationId));

        // 已确认过同一来源任务：幂等重放（同键同体）或 409（异体）
        var confirmed = repository.findConfirmedBySourceTask(consultationId, request.sourceTaskId());
        if (confirmed.isPresent()) {
            var msg = confirmed.get();
            boolean sameDigest = idempotencyKey.equals(msg.confirmIdempotencyKey())
                    && msg.confirmDigest() != null && msg.confirmDigest().equals(digest);
            if (!sameDigest) {
                throw new ApiException("ALREADY_CONFIRMED", HttpStatus.CONFLICT,
                        "该转写结果已确认过，不能用不同载荷再次确认");
            }
            return new InputConfirmed(toData(msg), true);
        }

        var draft = repository.findDraftBySourceTask(consultationId, request.sourceTaskId());
        if (draft.isEmpty()) {
            throw new ApiException("SOURCE_TASK_NOT_FOUND", HttpStatus.NOT_FOUND,
                    "未找到该会话下待确认的转写草稿（sourceTaskId 不属于本会话或已确认）");
        }
        var msg = draft.get();
        repository.confirmMessageCommitted(msg.id(), request.confirmedText(), idempotencyKey, digest);

        // 终止源任务后续生成（用户已核对；草稿文本不再进入诊疗流程）
        cancelUpstreamIfActive(userId, request.sourceTaskId());

        var updated = repository.findMessageById(msg.id()).orElseThrow();
        return new InputConfirmed(toData(updated), false);
    }

    /** 确认结果；replayed 用于 Idempotency-Replayed 头。 */
    public record InputConfirmed(MessageData message, boolean replayed) {
    }

    /**
     * 落转写草稿（M2.3 ASR 用）：识别文本先以 DRAFT 用户消息存进会话（不带幂等键——
     * 一次录音即一条草稿），未经用户 confirmations 确认不得据此生成结论。
     * 未带 consultationId 的识别只给文本、不落会话（契约 consultationId 可空）。
     * 返回草稿消息 ID，客户端确认时以它作为 sourceTaskId。
     */
    @Transactional
    public MessageData saveTranscriptDraft(String userId, String consultationId, String sourceTaskId, String text) {
        requireWritable(ownedConsultation(userId, consultationId));
        Instant now = clock.instant();
        String messageId = "msg-" + UUID.randomUUID();
        repository.insertMessage(new ConsultationRepository.MessageRow(
                messageId, consultationId, userId, "user", "VOICE_TRANSCRIPT", text,
                "USER_INPUT", null, null, "DRAFT", sourceTaskId, null, null, null, null, now));
        repository.touchConsultation(consultationId, now, now);
        var row = repository.findMessageById(messageId).orElseThrow();
        return toData(row);
    }

    // ---------------------------------------------------------------- 读取

    @Transactional(readOnly = true)
    public ConsultationDetail get(String userId, String consultationId, Instant afterCreatedAt,
                                  String afterId, int limit) {
        var row = ownedConsultation(userId, consultationId);
        List<MessageData> messages = repository.listMessages(consultationId, afterCreatedAt, afterId, limit)
                .stream().map(m -> toData(m)).toList();
        return new ConsultationDetail(toData(row), messages);
    }

    public record ConsultationDetail(ConsultationData consultation, List<MessageData> messages) {
    }

    /**
     * 契约 listConsultationMessages（N1，2026-10-19 补齐）：拉取会话消息正文。
     *  - 旧→新升序（repository 已保证），游标分页（limit+1 判 hasMore，nextCursor 取本页末条）；
     *  - 不存在或越权 → 404（ownedConsultation 统一处理，不泄露存在性）；
     *  - GET 无幂等键（契约未要求）。
     */
    @Transactional(readOnly = true)
    public MessagePage listMessages(String userId, String consultationId, Instant afterCreatedAt,
                                    String afterId, int limit) {
        ownedConsultation(userId, consultationId);
        List<ConsultationRepository.MessageRow> rows =
                repository.listMessages(consultationId, afterCreatedAt, afterId, limit + 1);
        boolean hasMore = rows.size() > limit;
        List<MessageData> messages = rows.stream().limit(limit).map(this::toData).toList();
        String nextCursor = null;
        if (hasMore && !messages.isEmpty()) {
            var last = rows.get(limit - 1);
            nextCursor = Cursors.encode(last.createdAt(), last.id());
        }
        return new MessagePage(messages, nextCursor);
    }

    /** 消息分页结果：messages + nextCursor（null = 无更多）。 */
    public record MessagePage(List<MessageData> messages, String nextCursor) {
    }

    @Transactional(readOnly = true)
    public List<ConsultationData> list(String userId, Instant beforeCreatedAt, String beforeId, int limit) {
        return repository.listConsultations(userId, beforeCreatedAt, beforeId, limit).stream()
                .map(r -> toData(r)).toList();
    }

    // ---------------------------------------------------------------- 内部

    /** 会话归属校验：不属于当前用户 → 404（不泄露存在性）。 */
    public ConsultationRepository.ConsultationRow ownedConsultation(String userId, String consultationId) {
        return repository.findConsultationById(consultationId)
                .filter(r -> userId.equals(r.userId()))
                .orElseThrow(() -> new ApiException("CONSULTATION_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "会话不存在"));
    }

    /**
     * 会话必须仍可写入（ACTIVE）：医生结束问诊后，消息 / 确认 / 语音草稿 / 分诊一律 409。
     * 收口前只有归属校验，已结束会话仍可写 → 患者能继续发消息、医生列表却已看不到该会话。
     */
    private void requireWritable(ConsultationRepository.ConsultationRow row) {
        if (!"ACTIVE".equals(row.status())) {
            throw new ApiException("CONSULTATION_CLOSED", HttpStatus.CONFLICT, "该咨询已结束，无法继续操作");
        }
    }

    /** 取消源任务（终止后续生成）；上游不可达/任务已终态都不影响确认成功。 */
    private void cancelUpstreamIfActive(String userId, String sourceTaskId) {
        try {
            aiTaskService.get(userId, sourceTaskId); // 触发同步，判断是否仍非终态
            aiTaskService.cancel(userId, sourceTaskId, "SUPERSEDED"); // 确认后由用户文本取代
        } catch (ApiException e) {
            // 任务不存在/已终态/上游暂不可达：确认语义仍成立（用户文本为准），不阻断
            log.info("确认后终止源任务跳过：code={}", e.getCode());
        }
    }

    /** safetyFor：取会话最近一次任务的上游 safety；无任务时给规则态安全提示。 */
    private SafetyData safetyFor(String consultationId) {
        return aiTaskService.findLatestForConsultation(consultationId)
                .map(t -> {
                    if (t.resultJson() == null || !"SUCCEEDED".equals(t.status())) {
                        return null;
                    }
                    try {
                        var node = mapper.readTree(t.resultJson()).path("safety");
                        if (node.isMissingNode() || node.isNull()) {
                            return null;
                        }
                        return new SafetyData(node.path("emergency").asBoolean(false),
                                node.path("level").asText("INFO"),
                                node.path("message").asText(null),
                                node.path("provenance").asText("AI_GENERATED"),
                                node.path("ruleSetVersion").asText(null));
                    } catch (JsonProcessingException e) {
                        return null;
                    }
                })
                .orElseGet(() -> new SafetyData(false, "INFO", "未命中急症红线，AI 回复仅供参考，不构成诊断。",
                        "RULE_RESULT", TriageRuleEngine.RULESET_VERSION));
    }

    // ---------------------------------------------------------------- 真实 AI 问诊：上下文与分诊

    /** CHAT 任务上下文条数（最近 12 条；再多对小模型只是噪声，还挤占 token 预算）。 */
    private static final int CHAT_CONTEXT_MESSAGES = 12;
    /** CHAT 上下文总字符上限；超出保留**尾部**（越近越重要）。 */
    private static final int CHAT_CONTEXT_MAX_CHARS = 3000;
    /** TRIAGE 症状文本上限，与 ai-service triage 执行器 _MAX_SYMPTOMS_CHARS 一致。 */
    private static final int TRIAGE_SYMPTOM_MAX_CHARS = 1000;

    /**
     * 拼多轮对话上下文（供 CHAT 执行器）。
     *
     * ⚠️ 2026-10-24 前这里不存在：每次只把「用户这一句」当 inputInline 交给模型，
     * 模型看不到前几轮问过什么、患者答过什么 —— 表现就是"一问一答、不会追问"。
     * 现在按「患者：/ 医生助手：」逐行拼最近 12 条，模型据此判断信息是否够、该追问什么。
     * system_notice（接诊提示）不进上下文：系统提示不是对话内容。
     */
    private String chatContext(String consultationId) {
        var rows = repository.listRecentMessages(consultationId, CHAT_CONTEXT_MESSAGES);
        StringBuilder sb = new StringBuilder();
        for (var m : rows) {
            String text = m.content() == null ? "" : m.content().trim();
            if (text.isEmpty()) {
                continue;
            }
            if ("user".equals(m.role())) {
                sb.append("患者：").append(text).append('\n');
            } else if ("doctor".equals(m.role()) || "assistant".equals(m.role())) {
                // ⚠️ 用「你：」而不是「医生助手：」（2026-10-24 实测）：写成「医生助手：」时
                // 7B 会把自己上一轮的问句当成别人说的话，于是把同一个问题再问一遍。
                sb.append("你：").append(text).append('\n');
            }
        }
        String ctx = sb.toString().trim();
        if (ctx.length() > CHAT_CONTEXT_MAX_CHARS) {
            ctx = ctx.substring(ctx.length() - CHAT_CONTEXT_MAX_CHARS);
        }
        return ctx;
    }

    /**
     * 症状聚合（供 TRIAGE 执行器）：只取患者侧发言，按时间用「；」连接。
     * 医生的追问不是症状，混进去会把分诊带偏。
     */
    private String symptomDigest(String consultationId) {
        var rows = repository.listRecentMessages(consultationId, 30);
        StringBuilder sb = new StringBuilder();
        for (var m : rows) {
            if (!"user".equals(m.role())) {
                continue;
            }
            String text = m.content() == null ? "" : m.content().trim();
            if (text.isEmpty()) {
                continue;
            }
            if (sb.length() > 0) {
                sb.append('；');
            }
            sb.append(text);
        }
        String s = sb.toString();
        return s.length() > TRIAGE_SYMPTOM_MAX_CHARS ? s.substring(0, TRIAGE_SYMPTOM_MAX_CHARS) : s;
    }

    /**
     * AI 分诊建议（TRIAGE 任务）：把会话里患者的全部描述聚合成症状文本，交远端模型给出
     * 「科室 + 置信度 + 依据」——这是 UI 上分诊结论卡的唯一来源，业务侧不做任何关键词猜测。
     *
     * 防抖：同会话 60s 内已有 TRIAGE 任务 → 直接复用（单并发模型下连点/重试会互相排队）。
     * 幂等：不落业务写数据，故不要求 Idempotency-Key；任务自身以 biz-taskId 作为上游幂等键。
     */
    public AiTaskService.AiTaskData recommendDepartment(String userId, String consultationId, String profile) {
        requireWritable(ownedConsultation(userId, consultationId));
        String symptoms = symptomDigest(consultationId);
        if (symptoms.isEmpty()) {
            throw new ApiException("INVALID_INPUT", HttpStatus.UNPROCESSABLE_ENTITY,
                    "会话里还没有患者描述，无法给出分诊建议");
        }
        var recent = aiTaskService.findLatestTriageForConsultation(consultationId);
        if (recent.isPresent()) {
            var row = recent.get();
            boolean fresh = row.createdAt() != null
                    && row.createdAt().isAfter(clock.instant().minusSeconds(60));
            if (fresh && !Set.of("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED").contains(row.status())) {
                return aiTaskService.toData(row);
            }
        }
        // ⚠️ 分诊默认走 large 档（qwen2.5:7b）：0.5b 实测会把兜底科室排在第一位、
        //    三个科室全给 0.9 置信度、reason 与输入症状对不上（2026-10-24 实测）——
        //    分诊直接决定患者挂哪个科，不能用这种结果。代价是 CPU 上单次 30~90s，故异步出卡。
        String useProfile = (profile == null || profile.isBlank()) ? "large-upgrade" : profile;
        var taskRow = aiTaskService.create(userId, consultationId, "TRIAGE",
                null, symptoms, useProfile, null, null);
        return aiTaskService.toData(taskRow);
    }

    /**
     * AI 回复落库（读时物化，2026-10-24）。
     *
     * CHAT 任务完成后，客户端下一次查任务状态时把 result.text 写成一条 `assistant` 消息。
     *
     * 为什么必须落库：
     *  · chatContext() 从 consultation_messages 拼多轮上下文 —— 若 AI 回复只存在 ai_tasks.result，
     *    下一轮模型看不到自己刚问过什么，会重复问同一个问题，"多轮收集信息"直接失效；
     *  · 患者退出重进也看不到任何 AI 回复，会话只剩自己单方面说话。
     *
     * 幂等：消息 id 由 taskId 派生（msg-{taskId}），先查后写，重复轮询不会重复插。
     * 安全：内容取自服务端落库的 result（不是客户端提交），客户端无法伪造 AI 发言。
     */
    public void materializeChatReply(AiTaskService.AiTaskRow row) {
        if (row == null || row.consultationId() == null || row.id() == null) {
            return;
        }
        if (!"CHAT".equals(row.taskType()) || !"SUCCEEDED".equals(row.status())) {
            return;
        }
        String reply = null;
        try {
            var node = row.resultJson() == null ? null : mapper.readTree(row.resultJson());
            reply = node == null ? null : node.path("text").asText(null);
        } catch (Exception e) {
            log.warn("AI 回复落库解析失败（跳过，不影响任务状态）| task={} | error={}",
                    row.id(), e.getClass().getSimpleName());
            return;
        }
        if (reply == null || reply.isBlank()) {
            return;
        }
        String messageId = "msg-" + row.id();
        if (repository.findMessageById(messageId).isPresent()) {
            return;
        }
        Instant at = row.createdAt() == null ? clock.instant() : row.createdAt();
        repository.insertMessage(new ConsultationRepository.MessageRow(
                messageId, row.consultationId(), row.userId(), "assistant", "TEXT", reply.trim(),
                "AI_GENERATED", null, null, null, row.id(), null, null, null, null, at));
        repository.touchConsultation(row.consultationId(), at, clock.instant());
    }

    // ---------------------------------------------------------------- 映射

    private ConsultationData toData(ConsultationRepository.ConsultationRow row) {
        // V21 医生卡字段：doctor_id 关联 brief；accepting 按「是否已出现医生侧消息」判定
        // （⚠️ 不用末条消息角色：患者再发言会把状态翻回「待接诊」—— 2026-10-24 修正；
        //   也不与 brief 是否存在耦合：医生资料缺失时接诊事实依然成立）
        var brief = repository.findDoctorBrief(row.doctorId()).orElse(null);
        boolean accepting = row.doctorId() != null && repository.hasNonUserMessage(row.id());
        return new ConsultationData(row.id(), row.title(), row.status(), row.lastMessageAt(),
                repository.countMessages(row.id()), row.summary(), row.createdAt(),
                brief == null ? null : brief.name(),
                brief == null ? null : brief.title(),
                brief == null ? null : brief.departmentName(),
                // ⚠️ 不要写成 brief == null ? null : accepting：医生说资料缺失时会把「已接诊」抹成 null
                accepting,
                null);
    }

    private MessageData toData(ConsultationRepository.MessageRow row) {
        return new MessageData(row.id(), row.role(), row.contentType(), row.content(), row.provenance(),
                parseCitations(row.citationsJson()), parseTags(row.riskTagsJson()),
                row.generationStatus(), row.createdAt());
    }

    // ---------------------------------------------------------------- JSON

    private List<CitationData> parseCitations(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readValue(json, new TypeReference<List<CitationData>>() {
            });
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private List<String> parseTags(String json) {
        if (json == null || json.isBlank()) {
            return null;
        }
        try {
            return mapper.readValue(json, new TypeReference<List<String>>() {
            });
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static String canonical(String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            sb.append(p == null ? "" : p).append('|');
        }
        return Digests.sha256Hex(sb.toString());
    }
}
