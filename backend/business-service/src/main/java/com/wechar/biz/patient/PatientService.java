package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.patient.dto.AttachmentData;
import com.wechar.biz.patient.dto.FamilyInvitationData;
import com.wechar.biz.patient.dto.FamilyInvitationSummaryData;
import com.wechar.biz.patient.dto.FamilyMemberData;
import com.wechar.biz.patient.dto.HealthRecordData;
import com.wechar.biz.patient.dto.InterpretationData;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

/**
 * patient 域（M1.2 健康档案 + 家庭成员，契约 health-records / family-members）：
 *  - 档案：category/recordedAt 必填；幂等键复用（同键同体重放、异体 409）；version 乐观锁更新；
 *  - 家庭成员：添加恒 proxyStatus=NONE（添加 ≠ 获得代理权限）；
 *  - 代操作权限（契约红线）：带 familyMemberId 的档案读写仅当 proxyStatus=GRANTED 放行，
 *    否则一律 404（"服务端必须校验当前用户对该成员的有效授权，否则返回 404"）；
 *  - 邀请：令牌一次性、仅创建响应返回；库内只存 SHA-256（"服务端只保存哈希"）。
 */
@Service
public class PatientService {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(PatientService.class);

    private static final List<String> CATEGORIES = List.of(
            "VITALS", "ALLERGY", "MEDICATION", "HISTORY", "EXAM", "OTHER");
    private static final Duration INVITE_TTL = Duration.ofHours(24);

    private final HealthRecordRepository healthRecords;
    private final FamilyRepository family;
    private final AttachmentRepository attachments;
    private final AttachmentStorage attachmentStorage;
    private final com.wechar.biz.consent.ConsentRepository consentRepository;
    private final com.wechar.biz.ai.AiTaskService aiTaskService;
    private final Duration interpretBudget;
    private final Clock clock;

    public PatientService(HealthRecordRepository healthRecords, FamilyRepository family,
                          AttachmentRepository attachments, AttachmentStorage attachmentStorage,
                          com.wechar.biz.consent.ConsentRepository consentRepository,
                          com.wechar.biz.ai.AiTaskService aiTaskService,
                          Clock clock,
                          @org.springframework.beans.factory.annotation.Value(
                                  "${wechar.interpret.await-seconds:60}") long interpretAwaitSeconds) {
        this.healthRecords = healthRecords;
        this.family = family;
        this.attachments = attachments;
        this.attachmentStorage = attachmentStorage;
        this.consentRepository = consentRepository;
        this.aiTaskService = aiTaskService;
        this.clock = clock;
        this.interpretBudget = Duration.ofSeconds(Math.max(5, interpretAwaitSeconds));
    }

    // ------------------------------------------------------------ 健康档案

    /** 档案列表：familyMemberId 缺省=本人档案；提供则先过 GRANTED 授权校验（无授权 404）。 */
    @Transactional(readOnly = true)
    public List<HealthRecordData> listRecords(String userId, String familyMemberId, int limit) {
        requireProxyGranted(userId, familyMemberId);
        return healthRecords.list(userId, familyMemberId, limit).stream()
                .map(this::toRecord).toList();
    }

    /** 新增档案（幂等键由控制器校验）。familyMemberId 需 GRANTED，否则 404。 */
    @Transactional
    public HealthRecordData createRecord(String userId, String idempotencyKey, String familyMemberId,
                                         String category, String title, String summary,
                                         Instant recordedAt, String source, String doctorName,
                                         Boolean abnormal, List<String> attachmentKeys) {
        requireProxyGranted(userId, familyMemberId);
        requireCategory(category);
        if (recordedAt == null) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "recordedAt 必填（契约 HealthRecordCreate）");
        }
        List<String> keys = attachmentKeys == null ? List.of() : attachmentKeys;
        for (String key : keys) {
            if (!attachmentStorage.exists(key)) {
                throw new ApiException("ATTACHMENT_NOT_FOUND", HttpStatus.UNPROCESSABLE_ENTITY,
                        "attachmentKeys 含无效对象键（文件不存在或已失效），请重新上传");
            }
        }
        String digest = Digests.sha256Hex(String.join("|",
                nullToEmpty(familyMemberId), category, nullToEmpty(title), nullToEmpty(summary),
                recordedAt.toString(), nullToEmpty(source), nullToEmpty(doctorName),
                abnormal == null ? "" : abnormal.toString(),
                String.join(",", keys)));

        var existing = healthRecords.findByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            var row = existing.get();
            if (!digest.equals(row.requestDigest())) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键");
            }
            return toRecord(row); // 同键同体 → 原资源（幂等重放）
        }
        String id = "hr-" + UUID.randomUUID();
        Instant now = clock.instant();
        healthRecords.insert(new HealthRecordRepository.HealthRecordRow(
                id, userId, familyMemberId, category, title, summary, recordedAt,
                source, doctorName, abnormal, null, null, 1, idempotencyKey, digest, now, null));
        // 建档即挂载附件（两段式上传的第二段：先 POST /api/v1/attachments 拿 objectKey）；
        // mime/size/sha256 全部从磁盘文件真实派生（不伪造）
        for (String key : keys) {
            // 只解析路径与大小，摘要走流式：10MB 扫描件不整份进堆（并发建档不再放大 GC）
            var file = attachmentStorage.resolve(key).orElseThrow(
                    () -> new ApiException("ATTACHMENT_NOT_FOUND", HttpStatus.UNPROCESSABLE_ENTITY,
                            "attachmentKeys 含无效对象键（文件不存在或已失效），请重新上传"));
            attachments.insert(new AttachmentRepository.AttachmentRow(
                    "hra-" + UUID.randomUUID(), id, userId, key, null,
                    file.contentType(), file.size(),
                    Digests.sha256Hex(file.path()), now));
        }
        return toRecord(healthRecords.findById(userId, id).orElseThrow());
    }

    /** 档案详情（契约外补充路径，复核要求；契约仅集合路径）。 */
    @Transactional(readOnly = true)
    public HealthRecordData getRecord(String userId, String recordId) {
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());
        return toRecord(row);
    }

    /** 档案更新（契约外补充路径，复核要求）：version 必填乐观锁；终态冲突 409。 */
    @Transactional
    public HealthRecordData updateRecord(String userId, String recordId, int version, String category,
                                         String title, String summary, Instant recordedAt) {
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());
        requireCategory(category == null ? row.category() : category);
        boolean updated = healthRecords.update(userId, recordId, version,
                category == null ? row.category() : category,
                title == null ? row.title() : title,
                summary == null ? row.summary() : summary,
                recordedAt == null ? row.recordedAt() : recordedAt, clock.instant());
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "版本不匹配（乐观锁），请刷新后重试");
        }
        return toRecord(healthRecords.findById(userId, recordId).orElseThrow());
    }

    /** 档案删除（契约外补充路径，复核要求）：不存在/越权 → 404。 */
    @Transactional
    public void deleteRecord(String userId, String recordId) {
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());
        // 先物理删附件文件再删行（行级联删附件行；文件需显式清理）
        for (var att : attachments.listByRecord(recordId)) {
            attachmentStorage.delete(att.objectKey());
        }
        healthRecords.delete(userId, recordId);
    }

    // ------------------------------------------------------------ 报告 AI 解读（N2）

    private static final String INTERPRET_DISCLAIMER = "AI 解读结果仅供参考，不能替代医师诊断。";

    /**
     * 契约 interpretHealthRecord（N2，2026-10-19）：报告 AI 解读。
     *
     * 2026-10-22 改造：**从规则式模板改为真实模型**。此前本方法用 interpretSummary /
     * interpretSections 在本地拼接档案字段（注释自述 "MVP，待 AI 模型接入"），既不是 AI，
     * 也违反"不得用本地模板冒充 AI 结果"的降级红线。现在改为：
     *   AiTaskService.create(type=INTERPRET) → ai-service → Ollama（qwen2.5 档位）
     *   → await 收口 → 结果映射为契约 Interpretation。
     *
     * 预算三档（任一层都不会比上游更早放弃）：
     *   ai-service 45s（AI_INTERPRET_TIMEOUT_SECONDS）
     *   < 本层 60s（wechar.interpret.await-seconds）
     *   < 网关 220s / 前端 aiTimeout 90s。
     *
     * 不变的红线：
     *  - 归属校验（越权 404）；reportStatus 非 READY → 422；scope 非 SUMMARY/DETAIL → 422；
     *  - 健康数据处理授权已撤回 → 422 CONSENT_WITHDRAWN；
     *  - disclaimer 原样下发；模型拒答 → status=FAILED + summary=拒答原因（不伪造解读内容）；
     *  - 上游失败/超时/输出非法 → 503/504 结构化降级，**绝不回落本地模板**。
     *
     * 注：本方法不再 readOnly —— 事务内要落 ai_tasks 行（AiTaskService.create 加入当前事务）。
     */
    @Transactional
    public InterpretationData interpret(String userId, String recordId, String scope) {
        // N11 撤回红线（2026-10-19）：HEALTH_DATA_PROCESSING 同意已撤回 → 停止处理（契约 422）。
        // 只看"最新一行是否 WITHDRAWN"：从未授意不阻断（无撤回事实），已重新授权即恢复。
        var consent = consentRepository.findLatest(userId, "HEALTH_DATA_PROCESSING");
        if (consent.isPresent() && "WITHDRAWN".equals(consent.get().get("status"))) {
            throw new ApiException("CONSENT_WITHDRAWN", HttpStatus.UNPROCESSABLE_ENTITY,
                    "健康数据处理授权已撤回，无法进行 AI 解读（可前往设置重新授权后重试）");
        }
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());

        String effectiveScope = (scope == null || scope.isBlank()) ? "SUMMARY" : scope.trim();
        if (!"SUMMARY".equals(effectiveScope) && !"DETAIL".equals(effectiveScope)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "scope 仅支持 SUMMARY / DETAIL（契约枚举）");
        }
        if (!"READY".equals(row.reportStatus())) {
            throw new ApiException("REPORT_NOT_READY", HttpStatus.UNPROCESSABLE_ENTITY,
                    "报告尚未出具，暂不支持 AI 解读（请等待报告出具后重试）");
        }

        // 模型档位由服务端决定（客户端不能选模型名）：解读用 0.5B 档保证响应时间，
        // 需要更长解释时可在此改为 large-upgrade（7B，须同步评估 CPU 时延）。
        var taskRow = aiTaskService.create(userId, null, "INTERPRET", null,
                buildInterpretInput(row, effectiveScope), "small-default", null, "zh-CN");
        var task = aiTaskService.await(userId, taskRow.id(), interpretBudget);

        if ("EXPIRED".equals(task.status())) {
            throw new ApiException("INTERPRET_TIMEOUT", HttpStatus.GATEWAY_TIMEOUT,
                    "AI 解读超时，请稍后重试", true, null);
        }
        if (!"SUCCEEDED".equals(task.status())) {
            log.info("健康档案解读任务未成功 status={} task={}", task.status(), taskRow.id());
            throw new ApiException("INTERPRET_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "AI 解读暂不可用，请稍后重试", true, null);
        }
        return toInterpretation(recordId, task.result());
    }

    /**
     * 任务输入：只放报告要点。姓名/手机号/证件号/病历号**不进** inputInline
     * （ai-openapi 明确要求身份信息走 inputRef，本任务不涉及身份信息）。
     */
    private static String buildInterpretInput(HealthRecordRepository.HealthRecordRow row, String scope) {
        StringBuilder sb = new StringBuilder();
        sb.append("档案标题：").append(dashIfBlank(row.title()));
        sb.append("；类别：").append(dashIfBlank(row.category()));
        if (row.hospital() != null && !row.hospital().isBlank()) {
            sb.append("；医院：").append(row.hospital());
        }
        if (row.source() != null && !row.source().isBlank()) {
            sb.append("；来源：").append(row.source());
        }
        if (row.doctorName() != null && !row.doctorName().isBlank()) {
            sb.append("；出具医师：").append(row.doctorName());
        }
        sb.append("；异常标注：").append(row.abnormal() == null ? "未标注" : (row.abnormal() ? "存在异常项" : "未见明显异常"));
        sb.append("；报告摘要：").append(dashIfBlank(row.summary()));
        sb.append("；解读范围：").append(scope);
        String text = sb.toString();
        // inputInline 契约上限 2000；超长截断（只截摘要尾部，保留结构化标记）
        return text.length() > 1900 ? text.substring(0, 1900) : text;
    }

    private static String dashIfBlank(String value) {
        return (value == null || value.isBlank()) ? "报告未提供" : value;
    }

    /**
     * 上游 result → 契约 Interpretation。
     *  - 模型拒答（refused）→ status=FAILED + summary=拒答原因（sections 空），不伪装成"暂无可解读内容"；
     *  - summary 与 sections 全空 → 视为上游输出非法（503），不用占位文案兜底。
     */
    private InterpretationData toInterpretation(String recordId,
                                                com.fasterxml.jackson.databind.JsonNode result) {
        if (result == null || result.isNull()) {
            throw new ApiException("INTERPRET_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "AI 解读暂不可用，请稍后重试", true, null);
        }
        boolean refused = result.path("refused").asBoolean(false);
        String refusalReason = textOf(result, "refusalReason");
        if (refused) {
            String reason = (refusalReason == null || refusalReason.isBlank())
                    ? "该问题超出报告解读范围，建议咨询出具报告的医师" : refusalReason;
            return new InterpretationData(recordId, "FAILED", clip(reason, 300), List.of(),
                    INTERPRET_DISCLAIMER, clock.instant());
        }
        String summary = clip(textOf(result, "summary"), 300);
        List<InterpretationData.Section> sections = parseSections(result.path("sections"));
        if (summary == null && sections.isEmpty()) {
            throw new ApiException("INTERPRET_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "AI 解读暂不可用，请稍后重试", true, null);
        }
        return new InterpretationData(recordId, "READY", summary, sections, INTERPRET_DISCLAIMER,
                clock.instant());
    }

    private List<InterpretationData.Section> parseSections(com.fasterxml.jackson.databind.JsonNode raw) {
        if (raw == null || !raw.isArray()) {
            return List.of();
        }
        List<InterpretationData.Section> sections = new java.util.ArrayList<>();
        for (var node : raw) {
            if (sections.size() >= 5) {
                break;
            }
            if (!node.isObject()) {
                continue;
            }
            String title = clip(textOf(node, "title"), 60);
            String body = clip(textOf(node, "body"), 1000);
            if (title == null && body == null) {
                continue;
            }
            Boolean abnormal = node.path("abnormal").isBoolean() ? node.path("abnormal").asBoolean() : null;
            sections.add(new InterpretationData.Section(title == null ? "解读" : title,
                    body == null ? "" : body, abnormal));
        }
        return sections;
    }

    private static String textOf(com.fasterxml.jackson.databind.JsonNode node, String field) {
        var value = node.path(field);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        String text = value.asText();
        return text.isBlank() ? null : text;
    }

    private static String clip(String value, int max) {
        if (value == null) {
            return null;
        }
        String trimmed = value.trim();
        if (trimmed.isEmpty()) {
            return null;
        }
        return trimmed.length() > max ? trimmed.substring(0, max) : trimmed;
    }

    // ------------------------------------------------------------ 检查资料附件（V9）

    /**
     * 上传附件并挂到既有档案（record-first 流程）：先校验档案归属（含代理授权），
     * 再落盘 + 插行，返回带短期签名 URL 的附件元数据。
     */
    @Transactional
    public AttachmentData uploadAttachment(String userId, String recordId, MultipartFile file) {
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());
        String objectKey = attachmentStorage.save(file);
        String sha256;
        byte[] bytes;
        try {
            bytes = file.getBytes();
            sha256 = Digests.sha256Hex(bytes);
        } catch (java.io.IOException e) {
            throw new ApiException("ATTACHMENT_READ_FAILED", HttpStatus.BAD_REQUEST, "文件读取失败，请重试");
        }
        Instant now = clock.instant();
        String id = "hra-" + UUID.randomUUID();
        attachments.insert(new AttachmentRepository.AttachmentRow(
                id, recordId, userId, objectKey, file.getOriginalFilename(),
                file.getContentType() == null ? "application/octet-stream" : file.getContentType(),
                file.getSize(), sha256, now));
        return new AttachmentData(id, objectKey, attachmentStorage.signedUrl(objectKey),
                file.getOriginalFilename(),
                file.getContentType() == null ? "application/octet-stream" : file.getContentType(),
                file.getSize(), sha256, now);
    }

    /** 附件列表（含短期签名 URL；过期时客户端重新拉取档案即得新 URL）。 */
    @Transactional(readOnly = true)
    public List<AttachmentData> listAttachments(String userId, String recordId) {
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());
        return attachments.listByRecord(recordId).stream()
                .map(a -> new AttachmentData(a.id(), a.objectKey(),
                        attachmentStorage.signedUrl(a.objectKey()),
                        a.fileName(), a.mime(), a.size(), a.sha256(), a.createdAt()))
                .toList();
    }

    /** 删除附件：不存在/越权 → 404；物理删文件 + 删行。 */
    @Transactional
    public void deleteAttachment(String userId, String recordId, String attachmentId) {
        var row = healthRecords.findById(userId, recordId)
                .orElseThrow(() -> new ApiException("HEALTH_RECORD_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "健康档案不存在"));
        requireProxyGranted(userId, row.familyMemberId());
        var att = attachments.findById(recordId, attachmentId)
                .orElseThrow(() -> new ApiException("ATTACHMENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "附件不存在"));
        attachments.delete(recordId, attachmentId);
        attachmentStorage.delete(att.objectKey());
    }

    // ------------------------------------------------------------ 家庭成员

    @Transactional(readOnly = true)
    public List<FamilyMemberData> listMembers(String userId) {
        return family.listMembers(userId).stream().map(PatientService::toMember).toList();
    }

    /** 添加成员：proxyStatus 恒 NONE（添加 ≠ 获权），幂等键复用。 */
    @Transactional
    public FamilyMemberData createMember(String userId, String idempotencyKey, String displayName,
                                         String relation, String ageBand, String gender, String phone) {
        if (displayName == null || displayName.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, "displayName 必填");
        }
        if (relation == null || relation.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, "relation 必填");
        }
        String digest = Digests.sha256Hex(String.join("|", displayName, relation,
                nullToEmpty(ageBand), nullToEmpty(gender), phoneHashOf(phone)));
        var existing = family.findMemberByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            var storedDigest = family.findByIdempotencyKeyDigest(userId, idempotencyKey).orElse(null);
            if (!digest.equals(storedDigest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键");
            }
            return toMember(existing.get()); // 同键同体 → 原资源
        }
        String id = "fm-" + UUID.randomUUID();
        Instant now = clock.instant();
        family.insertMember(new FamilyRepository.MemberRow(id, userId, displayName, relation,
                "NONE", ageBand, gender, null, phoneHashOf(phone), maskPhone(phone), now, now),
                idempotencyKey, digest);
        return toMember(family.findMember(userId, id).orElseThrow());
    }

    @Transactional
    public FamilyMemberData updateMember(String userId, String memberId, String displayName,
                                         String relation, String ageBand, String gender) {
        var row = family.findMember(userId, memberId)
                .orElseThrow(() -> new ApiException("FAMILY_MEMBER_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "家庭成员不存在"));
        family.updateMember(userId, memberId,
                displayName == null ? row.displayName() : displayName,
                relation == null ? row.relation() : relation,
                ageBand == null ? row.ageBand() : ageBand,
                gender == null ? row.gender() : gender, clock.instant());
        return toMember(family.findMember(userId, memberId).orElseThrow());
    }

    @Transactional
    public void deleteMember(String userId, String memberId) {
        family.findMember(userId, memberId)
                .orElseThrow(() -> new ApiException("FAMILY_MEMBER_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "家庭成员不存在"));
        family.deleteMember(userId, memberId);
    }

    /** 当前用户发出的邀请列表（GET /family-members/invitations）：只回元数据，不下发令牌/哈希。 */
    @Transactional(readOnly = true)
    public List<FamilyInvitationSummaryData> listInvitations(String userId, int limit) {
        return family.listInvitations(userId, limit).stream()
                .map(i -> new FamilyInvitationSummaryData(i.invitationId(), i.relation(), i.channel(),
                        i.status(), i.expiresAt(), i.createdAt()))
                .toList();
    }

    /**
     * 发起绑定邀请：令牌仅本次响应返回，库内仅 SHA-256。
     * 注意：邀请创建不改 proxyStatus —— 添加/邀请都不等于获得代理权限。
     */
    @Transactional
    public FamilyInvitationData createInvitation(String userId, String relation, String channel,
                                                 String phone) {
        if (relation == null || relation.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, "relation 必填");
        }
        String token = "inv-" + UUID.randomUUID() + "-" + UUID.randomUUID();
        String invitationId = "in-" + UUID.randomUUID();
        Instant now = clock.instant();
        family.insertInvitation(new FamilyRepository.InvitationRow(invitationId, userId, relation,
                channel, Digests.sha256Hex(token), phoneHashOf(phone), "PENDING", now.plus(INVITE_TTL), now));
        return new FamilyInvitationData(invitationId, token, now.plus(INVITE_TTL), channel);
    }

    /** 接受邀请（契约外补充，联调用）：核销一次性令牌，成功后授予邀请人对创建成员的 GRANTED。 */
    @Transactional
    public String acceptInvitation(String token, String memberId) {
        if (token == null || token.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, "token 必填");
        }
        var invite = family.findInvitationByTokenHash(Digests.sha256Hex(token))
                .orElseThrow(() -> new ApiException("INVITATION_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "邀请不存在或已失效"));
        if (!"PENDING".equals(invite.status()) || invite.expiresAt().isBefore(clock.instant())) {
            throw new ApiException("INVITATION_EXPIRED", HttpStatus.CONFLICT,
                    "邀请已使用或已过期（一次性）");
        }
        if (!family.consumeInvitation(invite.invitationId(), clock.instant())) {
            throw new ApiException("INVITATION_EXPIRED", HttpStatus.CONFLICT,
                    "邀请已使用或已过期（一次性）");
        }
        // 授权生效：仅接受成功后 GRANTED（对邀请人 user_id 的该成员）
        var member = family.findMember(invite.userId(), memberId)
                .orElseThrow(() -> new ApiException("FAMILY_MEMBER_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "目标成员不存在"));
        family.grantProxy(invite.userId(), member.id(), clock.instant());
        return invite.userId();
    }

    // ------------------------------------------------------------ 内部

    /** 契约红线：带 familyMemberId 的档案操作，无 GRANTED 授权一律 404（不泄露存在性）。 */
    private void requireProxyGranted(String userId, String familyMemberId) {
        if (familyMemberId == null || familyMemberId.isBlank()) {
            return; // 本人档案
        }
        family.findMemberByStatus(userId, familyMemberId, "GRANTED")
                .orElseThrow(() -> new ApiException("FAMILY_MEMBER_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "家庭成员不存在或未获得代理授权（添加不等于授权）"));
    }

    private void requireCategory(String category) {
        if (category == null || !CATEGORIES.contains(category)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "category 必须为 " + CATEGORIES + " 之一（契约枚举）");
        }
    }

    private static String phoneHashOf(String phone) {
        return phone == null || phone.isBlank() ? null : Digests.sha256Hex(phone);
    }

    private HealthRecordData toRecord(HealthRecordRepository.HealthRecordRow r) {
        List<AttachmentData> list = attachments.listByRecord(r.id()).stream()
                .map(a -> new AttachmentData(a.id(), a.objectKey(),
                        attachmentStorage.signedUrl(a.objectKey()),
                        a.fileName(), a.mime(), a.size(), a.sha256(), a.createdAt()))
                .toList();
        return new HealthRecordData(r.id(), r.familyMemberId(), r.category(), r.title(), r.summary(),
                r.recordedAt(), r.source(), r.doctorName(), r.abnormal(), r.reportStatus(), r.hospital(),
                list, r.version());
    }

    private static FamilyMemberData toMember(FamilyRepository.MemberRow m) {
        return new FamilyMemberData(m.id(), m.displayName(), m.relation(), m.proxyStatus(),
                m.ageBand(), m.gender() == null ? "UNKNOWN" : m.gender(),
                m.phoneMasked(), m.avatarUrl());
    }

    /** 脱敏展示号（138****0001）：只用于区分重名成员，明文手机号仍只存哈希。 */
    private static String maskPhone(String phone) {
        if (phone == null || phone.isBlank()) {
            return null;
        }
        String trimmed = phone.trim();
        if (trimmed.length() < 7) {
            return "***";
        }
        return trimmed.substring(0, 3) + "****" + trimmed.substring(trimmed.length() - 4);
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
