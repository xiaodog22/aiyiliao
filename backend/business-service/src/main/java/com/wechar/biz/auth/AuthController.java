package com.wechar.biz.auth;

import com.wechar.biz.auth.dto.PhoneBindRequest;
import com.wechar.biz.auth.dto.PhoneBindResult;
import com.wechar.biz.auth.dto.SessionData;
import com.wechar.biz.auth.dto.SmsChallengeData;
import com.wechar.biz.auth.dto.SmsSendRequest;
import com.wechar.biz.auth.dto.WechatLoginRequest;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import jakarta.validation.Valid;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * auth 域控制器（M1.1 契约路径）：
 *  POST /api/v1/auth/wechat/login（OkSession）· POST /api/v1/auth/refresh（OkSession）
 *  POST /api/v1/auth/logout（OkLogoutResult {revoked}）· GET /api/v1/auth/session（契约外补充，README 已标注）
 *  POST /api/v1/auth/phone/bind（契约外 dev 便利，契约路径是 login.phoneCode，README 已标注）
 *  POST /api/v1/auth/sms/send（N9 短信验证码，匿名 + Idempotency-Key 必填）。
 * 契约 ClientVersion/Platform 为 login/doctor-login 的 required 头：缺失由 Spring → 400 统一信封；
 * Platform 枚举 const=wechat-miniprogram，非该值 → 422 VALIDATION_FAILED。
 */
@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;
    private final SmsChallengeService smsChallengeService;
    private final CurrentUserContext currentUserContext;

    public AuthController(AuthService authService, SmsChallengeService smsChallengeService,
                          CurrentUserContext currentUserContext) {
        this.authService = authService;
        this.smsChallengeService = smsChallengeService;
        this.currentUserContext = currentUserContext;
    }

    @PostMapping("/wechat/login")
    public ResponseEntity<Envelope<SessionData>> wechatLogin(
            @RequestHeader(value = "X-Client-Version", required = true) String clientVersion,
            @RequestHeader(value = "X-Platform", required = true) String platform,
            @Valid @RequestBody WechatLoginRequest request) {
        if (!"wechat-miniprogram".equals(platform)) {
            throw new com.wechar.biz.common.ApiException("VALIDATION_FAILED",
                    org.springframework.http.HttpStatus.UNPROCESSABLE_ENTITY,
                    "X-Platform 仅接受 wechat-miniprogram（契约 const）");
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), authService.login(request)));
    }

    @PostMapping("/refresh")
    public ResponseEntity<Envelope<SessionData>> refresh(@Valid @RequestBody RefreshRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), authService.refresh(request.refreshToken())));
    }

    @PostMapping("/logout")
    public ResponseEntity<Envelope<Map<String, Object>>> logout(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = true) String idempotencyKey,
            @RequestHeader(value = "Authorization", required = false) String authorization) {
        IdempotencyKeys.require(idempotencyKey); // 契约 required；缺失由 Spring → 400
        String accessToken = null;
        if (authorization != null && authorization.startsWith("Bearer ")) {
            accessToken = authorization.substring("Bearer ".length()).trim();
        }
        // 重复注销幂等：已撤销/未知令牌均返回同一终态语义；无令牌（占位鉴权）如实 false
        boolean revoked = authService.logout(accessToken, idempotencyKey);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), Map.of("revoked", revoked)));
    }

    @GetMapping("/session")
    public ResponseEntity<Envelope<SessionData>> session() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), authService.issueFreshSession(userId)));
    }

    /** 契约 sendSmsChallenge（N9）：匿名端点，Idempotency-Key 必填（契约参数 required）。 */
    @PostMapping("/sms/send")
    public ResponseEntity<Envelope<SmsChallengeData>> sendSms(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody SmsSendRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey); // 缺失/超长 → 400（契约 required）
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                smsChallengeService.send(request.phone().trim(), request.scene(), key)));
    }

    @PostMapping("/phone/bind")
    public ResponseEntity<Envelope<PhoneBindResult>> bindPhone(
            @RequestHeader(value = "X-Client-Version", required = false) String clientVersion,
            @Valid @RequestBody PhoneBindRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        PhoneBindResult result = authService.bindPhone(userId, request);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), result));
    }

    /** 契约 refresh 请求体：required=[refreshToken]（minLength 16）。 */
    public record RefreshRequest(@jakarta.validation.constraints.NotBlank
                                 @jakarta.validation.constraints.Size(min = 16, max = 512)
                                 String refreshToken) {
    }
}
