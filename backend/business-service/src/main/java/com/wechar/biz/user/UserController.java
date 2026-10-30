package com.wechar.biz.user;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.user.dto.AccountDeletionVerifyRequest;
import com.wechar.biz.user.dto.AuthRevokeRequest;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * user 域控制器（N10/N11，2026-10-19，契约 tag=me）：
 *  DELETE /api/v1/user/account（账号注销：软删 30 天冷静期 + 二次校验；Idempotency-Key 必填）
 *  POST   /api/v1/user/auth/revoke（撤回授权同意；Idempotency-Key 必填）
 * 均为受保护端点（契约声明 401，匿名登记于 AuthInterceptor.ANONYMOUS 之外）。
 */
@RestController
@RequestMapping("/api/v1/user")
public class UserController {

    private final AccountService accountService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public UserController(AccountService accountService, AuthService authService,
                          CurrentUserContext currentUserContext) {
        this.accountService = accountService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    /** 契约 deleteAccount：缺失 body 字段 → 422（bean validation）；缺幂等键 → 400。 */
    @DeleteMapping("/account")
    public ResponseEntity<Envelope<Map<String, Object>>> deleteAccount(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @RequestHeader(value = "Authorization", required = false) String authorization,
            @Valid @RequestBody AccountDeletionVerifyRequest request) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        String accessToken = authorization != null && authorization.startsWith("Bearer ")
                ? authorization.substring("Bearer ".length()).trim() : null;
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                accountService.deleteAccount(userId, request, accessToken)));
    }

    /** 契约 revokeAuthorization：scope 非法 → 422；缺幂等键 → 400；同键异载荷 → 409。 */
    @PostMapping("/auth/revoke")
    public ResponseEntity<Envelope<Map<String, Object>>> revokeAuthorization(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody AuthRevokeRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), accountService.revoke(userId, key, request)));
    }
}
