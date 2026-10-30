package com.wechar.biz.bed;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.bed.dto.BedAssignmentRequest;
import com.wechar.biz.bed.dto.BedData;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
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
 * beds 控制器（M3 契约路径，tag=doctor）：
 *  GET  /api/v1/beds（wardId?/status?；范围 = 登录医生的授权病区）
 *  POST /api/v1/beds/{bedId}/assignment（Idempotency-Key 必填；乐观锁 expectedVersion）
 */
@RestController
@RequestMapping("/api/v1/beds")
public class BedController {

    private static final int PATH_ID_MAX = 64;

    private final BedService bedService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public BedController(BedService bedService, AuthService authService, CurrentUserContext currentUserContext) {
        this.bedService = bedService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<BedData>>> list(@RequestParam(required = false) String wardId,
                                                        @RequestParam(required = false) String status) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), bedService.list(userId, wardId, status)));
    }

    @PostMapping("/{bedId}/assignment")
    public ResponseEntity<Envelope<BedData>> assign(
            @PathVariable String bedId,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody BedAssignmentRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失 → 400（契约参数 required）
        if (bedId == null || bedId.isBlank() || bedId.length() > PATH_ID_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "bedId 长度须为 1~64 字符");
        }
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                bedService.assign(userId, bedId, key, request)));
    }
}
