package com.wechar.biz.deletion;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.deletion.dto.DeletionRequestCreateRequest;
import com.wechar.biz.deletion.dto.DeletionRequestData;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 删除/注销申请控制器（M3 契约路径，tag=me；与 MeController 前缀不冲突）：
 *  POST /api/v1/me/deletion-requests（Idempotency-Key 必填）
 *  GET  /api/v1/me/deletion-requests/{requestId}（他人申请 → 404）
 */
@RestController
@RequestMapping("/api/v1/me/deletion-requests")
public class DeletionController {

    private final DeletionService deletionService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public DeletionController(DeletionService deletionService, AuthService authService,
                              CurrentUserContext currentUserContext) {
        this.deletionService = deletionService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @PostMapping
    public ResponseEntity<Envelope<DeletionRequestData>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestBody DeletionRequestCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失 → 400（契约参数 required）
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                deletionService.create(userId, key, request)));
    }

    @GetMapping("/{requestId}")
    public ResponseEntity<Envelope<DeletionRequestData>> get(@PathVariable String requestId) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), deletionService.get(userId, requestId)));
    }
}
