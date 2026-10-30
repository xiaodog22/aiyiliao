package com.wechar.biz.patient;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.patient.dto.AttachmentData;
import com.wechar.biz.patient.dto.FamilyInvitationCreateRequest;
import com.wechar.biz.patient.dto.FamilyInvitationData;
import com.wechar.biz.patient.dto.FamilyInvitationSummaryData;
import com.wechar.biz.patient.dto.FamilyMemberCreateRequest;
import com.wechar.biz.patient.dto.FamilyMemberData;
import com.wechar.biz.patient.dto.HealthRecordCreateRequest;
import com.wechar.biz.patient.dto.HealthRecordData;
import com.wechar.biz.patient.dto.HealthRecordUpdateRequest;
import com.wechar.biz.patient.dto.InterpretationData;
import com.wechar.biz.patient.dto.InterpretationRequest;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * patient 域控制器（M1.2）：
 * 契约路径：GET|POST /api/v1/health-records · GET|POST /api/v1/family-members
 *          POST /api/v1/family-members/invitations
 * 契约外补充（复核要求的 Item 路径，契约仅集合路径）：GET|PUT|DELETE /health-records/{recordId}
 *          GET|PATCH|DELETE /family-members/{memberId} —— README 已如实标注。
 * 写操作 Idempotency-Key 必填（契约 parameters required）。
 */
@RestController
@RequestMapping("/api/v1")
public class PatientController {

    private static final int DEFAULT_LIMIT = 20;
    private static final int MAX_LIMIT = 50;

    private final PatientService patientService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public PatientController(PatientService patientService, AuthService authService,
                             CurrentUserContext currentUserContext) {
        this.patientService = patientService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    private String userId() {
        return authService.ensureUser(currentUserContext.currentUserId());
    }

    // ------------------------------------------------------------ 健康档案

    @GetMapping("/health-records")
    public ResponseEntity<Envelope<List<HealthRecordData>>> listRecords(
            @RequestParam(required = false) String familyMemberId,
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientService.listRecords(userId(), familyMemberId, bounded)));
    }

    @PostMapping("/health-records")
    public ResponseEntity<Envelope<HealthRecordData>> createRecord(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody HealthRecordCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失 → 400
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.createRecord(
                userId(), key, request.familyMemberId(), request.category(), request.title(),
                request.summary(), request.recordedAt(), request.source(), request.doctorName(),
                request.abnormal(), request.attachmentKeys())));
    }

    @GetMapping("/health-records/{recordId}")
    public ResponseEntity<Envelope<HealthRecordData>> getRecord(@PathVariable String recordId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.getRecord(userId(), recordId)));
    }

    @PutMapping("/health-records/{recordId}")
    public ResponseEntity<Envelope<HealthRecordData>> updateRecord(
            @PathVariable String recordId, @Valid @RequestBody HealthRecordUpdateRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.updateRecord(
                userId(), recordId, request.version(), request.category(), request.title(),
                request.summary(), request.recordedAt())));
    }

    @DeleteMapping("/health-records/{recordId}")
    public ResponseEntity<Envelope<Object>> deleteRecord(@PathVariable String recordId) {
        patientService.deleteRecord(userId(), recordId);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), null));
    }

    /** 契约 interpretHealthRecord（N2，2026-10-19）：报告 AI 解读；越权 404，报告未出具 422。 */
    @PostMapping("/health-records/{recordId}/interpret")
    public ResponseEntity<Envelope<InterpretationData>> interpretRecord(
            @PathVariable String recordId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody InterpretationRequest request) {
        IdempotencyKeys.require(idempotencyKey); // 缺失 → 400（契约写操作口径）
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientService.interpret(userId(), recordId, request.scope())));
    }

    // ------------------------------------------------------------ 检查资料附件（V9）

    /**
     * 附件列表（含短期签名 URL）。url 可能已过期，过期时重新拉取本接口即得新 URL。
     */
    @GetMapping("/health-records/{recordId}/attachments")
    public ResponseEntity<Envelope<List<AttachmentData>>> listAttachments(@PathVariable String recordId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientService.listAttachments(userId(), recordId)));
    }

    /**
     * 上传附件并挂到既有档案（multipart part="file"；≤10MB，jpg/png/webp/pdf）。
     * 幂等键必填（契约写操作口径）；同键同体重放返回原资源。
     */
    @PostMapping("/health-records/{recordId}/attachments")
    public ResponseEntity<Envelope<AttachmentData>> uploadAttachment(
            @PathVariable String recordId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestPart("file") MultipartFile file) {
        IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientService.uploadAttachment(userId(), recordId, file)));
    }

    /** 删除附件（前端负责二次确认）；不存在/越权 → 404。 */
    @DeleteMapping("/health-records/{recordId}/attachments/{attachmentId}")
    public ResponseEntity<Envelope<Object>> deleteAttachment(@PathVariable String recordId,
                                                             @PathVariable String attachmentId) {
        patientService.deleteAttachment(userId(), recordId, attachmentId);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), null));
    }

    // ------------------------------------------------------------ 家庭成员

    @GetMapping("/family-members")
    public ResponseEntity<Envelope<List<FamilyMemberData>>> listMembers() {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.listMembers(userId())));
    }

    @PostMapping("/family-members")
    public ResponseEntity<Envelope<FamilyMemberData>> createMember(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody FamilyMemberCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.createMember(
                userId(), key, request.displayName(), request.relation(), request.ageBand(),
                request.gender(), request.phone())));
    }

    /**
     * 邀请列表（GET）：必须声明在 /{memberId} 之前解析语义上更清晰（Spring 本身优先字面量），
     * 修复 §2.4 中 "invitations 被 {id} 吞掉 → 404" 的缺陷。
     */
    @GetMapping("/family-members/invitations")
    public ResponseEntity<Envelope<List<FamilyInvitationSummaryData>>> listInvitations(
            @RequestParam(required = false, defaultValue = "" + DEFAULT_LIMIT) int limit) {
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientService.listInvitations(userId(), bounded)));
    }

    @GetMapping("/family-members/{memberId}")
    public ResponseEntity<Envelope<FamilyMemberData>> getMember(@PathVariable String memberId) {
        var member = patientService.listMembers(userId()).stream()
                .filter(m -> m.id().equals(memberId)).findFirst()
                .orElseThrow(() -> new com.wechar.biz.common.ApiException("FAMILY_MEMBER_NOT_FOUND",
                        org.springframework.http.HttpStatus.NOT_FOUND, "家庭成员不存在"));
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), member));
    }

    @PatchMapping("/family-members/{memberId}")
    public ResponseEntity<Envelope<FamilyMemberData>> updateMember(
            @PathVariable String memberId, @Valid @RequestBody FamilyMemberUpdateRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.updateMember(
                userId(), memberId, request.displayName(), request.relation(), request.ageBand(),
                request.gender())));
    }

    @DeleteMapping("/family-members/{memberId}")
    public ResponseEntity<Envelope<Object>> deleteMember(@PathVariable String memberId) {
        patientService.deleteMember(userId(), memberId);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), null));
    }

    @PostMapping("/family-members/invitations")
    public ResponseEntity<Envelope<FamilyInvitationData>> createInvitation(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody FamilyInvitationCreateRequest request) {
        // 契约声明 Idempotency-Key；邀请令牌本身一次性，键缺失按契约 400
        IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), patientService.createInvitation(
                userId(), request.relation(), request.channel(), request.phone())));
    }

    /** PATCH 成员请求（契约外补充路径的请求体；宽松收未知字段，见 JacksonStrictConfig）。 */
    @com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
    public record FamilyMemberUpdateRequest(
            @jakarta.validation.constraints.Size(max = 40) String displayName,
            @jakarta.validation.constraints.Size(max = 20) String relation,
            @jakarta.validation.constraints.Size(max = 20) String ageBand,
            @jakarta.validation.constraints.Size(max = 8) String gender) {
    }
}
