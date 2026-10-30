package com.wechar.biz.consent;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.consent.dto.ConsentGrantRequest;
import jakarta.validation.Valid;
import java.util.List;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * consents 控制器（M3 契约路径，tag=me）：
 *  GET  /api/v1/consents（OkConsentRecordList）
 *  POST /api/v1/consents（OkConsentRecord；Idempotency-Key 必填）
 *  POST /api/v1/consents/{purpose}/withdraw（body 可选 {reason?}；Idempotency-Key 必填）
 * 同意记录为只读视图 + 追加写入，响应形状与 /me 的 User.consents 同源（ConsentRepository 单一查询）。
 */
@RestController
@RequestMapping("/api/v1/consents")
public class ConsentController {

    private final ConsentService consentService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public ConsentController(ConsentService consentService, AuthService authService,
                             CurrentUserContext currentUserContext) {
        this.consentService = consentService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<Map<String, Object>>>> list() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), consentService.list(userId)));
    }

    @PostMapping
    public ResponseEntity<Envelope<Map<String, Object>>> grant(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody ConsentGrantRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失 → 400（契约参数 required）
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), consentService.grant(userId, key, request)));
    }

    @PostMapping("/{purpose}/withdraw")
    public ResponseEntity<Envelope<Map<String, Object>>> withdraw(
            @PathVariable String purpose,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestBody(required = false) WithdrawRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String reason = request == null ? null : request.reason();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                consentService.withdraw(userId, purpose, key, reason)));
    }

    /** 契约 withdraw 请求体：object，properties.reason ≤200，非必填（可空 body）。 */
    @JsonIgnoreProperties(ignoreUnknown = true)
    public record WithdrawRequest(String reason) {
    }
}
