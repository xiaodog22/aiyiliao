package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.patient.dto.PatientCreateRequest;
import com.wechar.biz.patient.dto.PatientData;
import com.wechar.biz.patient.dto.PatientMappingData;
import com.wechar.biz.patient.dto.PatientUpdateRequest;
import com.wechar.biz.auth.AuthService;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.validation.annotation.Validated;
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
 * 就诊人主索引（P3 病历/报告前置，2026-11-27）。
 *
 * <p>契约：{@code docs/患者主索引接口契约_20261127.md} §4；OpenAPI：
 * {@code backend/contracts/business-openapi.yaml} 的 {@code /api/v1/patients*}。</p>
 *
 * <p>开关关闭时（{@code wechar.patient-index.enabled=false}，默认）所有接口返回 404 ——
 * 这是本功能的回滚手段：前端功能隐藏，预约与报告继续走旧链路，不需要回滚数据库。</p>
 */
@RestController
@RequestMapping("/api/v1/patients")
@Validated
public class PatientIndexController {

    private final PatientIndexService patientIndexService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public PatientIndexController(PatientIndexService patientIndexService,
                                  AuthService authService,
                                  CurrentUserContext currentUserContext) {
        this.patientIndexService = patientIndexService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    private String userId() {
        return authService.ensureUser(currentUserContext.currentUserId());
    }

    /** 开关关闭 → 404（与「接口不存在」同语义，避免暴露未启用能力）。 */
    private void requireEnabled() {
        if (!patientIndexService.isEnabled()) {
            throw new ApiException("NOT_FOUND", HttpStatus.NOT_FOUND, "资源不存在");
        }
    }

    @GetMapping
    public ResponseEntity<Envelope<List<PatientData>>> list(
            @RequestParam(required = false, defaultValue = "false") boolean includeArchived) {
        requireEnabled();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientIndexService.list(userId(), includeArchived)));
    }

    @PostMapping
    public ResponseEntity<Envelope<PatientData>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody PatientCreateRequest request) {
        requireEnabled();
        String key = IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientIndexService.create(userId(), key, request)));
    }

    @GetMapping("/{patientRef}")
    public ResponseEntity<Envelope<PatientData>> get(@PathVariable String patientRef) {
        requireEnabled();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientIndexService.get(userId(), patientRef)));
    }

    @PatchMapping("/{patientRef}")
    public ResponseEntity<Envelope<PatientData>> update(
            @PathVariable String patientRef,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody PatientUpdateRequest request) {
        requireEnabled();
        IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientIndexService.update(userId(), patientRef, request)));
    }

    @PostMapping("/{patientRef}/archive")
    public ResponseEntity<Envelope<PatientData>> archive(
            @PathVariable String patientRef,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey) {
        requireEnabled();
        IdempotencyKeys.require(idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientIndexService.archive(userId(), patientRef)));
    }

    @GetMapping("/{patientRef}/mapping")
    public ResponseEntity<Envelope<PatientMappingData>> mapping(@PathVariable String patientRef) {
        requireEnabled();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                patientIndexService.mapping(userId(), patientRef)));
    }
}
