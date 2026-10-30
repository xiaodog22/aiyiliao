package com.wechar.biz.auth;

import com.wechar.biz.auth.dto.PhoneBindRequest;
import com.wechar.biz.auth.dto.PhoneBindResult;
import com.wechar.biz.auth.dto.SessionData;
import com.wechar.biz.auth.dto.WechatLoginRequest;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.AuthSessionStore;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.crypto.PhoneCrypto;
import com.wechar.biz.user.ProfileRepository;
import com.wechar.biz.user.UserRepository;
import com.wechar.biz.user.UserService;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 登录与会话服务（M1.1 契约对齐）：
 *  - 微信 code → openid（dev 适配器），登录自动创建 users + user_profiles 行（空档案）；
 *  - 返回契约 Session：access/refresh 为随机令牌（库内只存 SHA-256），expiresIn≥60，tokenType=Bearer；
 *  - 手机号绑定走 login.phoneCode（契约路径）；POST /auth/phone/bind 为契约外 dev 便利，README 已标注；
 *  - refresh：一次一换（轮换即失效，重放 → 401）；logout：撤销整链，重复调用幂等。
 */
@Service
public class AuthService {

    private final WechatSessionProvider wechatSessionProvider;
    private final UserRepository userRepository;
    private final ProfileRepository profileRepository;
    private final PhoneCrypto phoneCrypto;
    private final UserService userService;
    private final AuthSessionStore authSessionStore;
    private final Clock clock;

    public AuthService(WechatSessionProvider wechatSessionProvider, UserRepository userRepository,
                       ProfileRepository profileRepository, PhoneCrypto phoneCrypto, UserService userService,
                       AuthSessionStore authSessionStore, Clock clock) {
        this.wechatSessionProvider = wechatSessionProvider;
        this.userRepository = userRepository;
        this.profileRepository = profileRepository;
        this.phoneCrypto = phoneCrypto;
        this.userService = userService;
        this.authSessionStore = authSessionStore;
        this.clock = clock;
    }

    /** 微信登录：换 code → upsert 用户/空档案 → 签发会话（契约 OkSession）。 */
    @Transactional
    public SessionData login(WechatLoginRequest request) {
        return issueSession(loginIdentity(request));
    }

    /**
     * 登录前半段（医生端登录共用）：换 code → upsert 用户 + 空档案 + 手机号绑定 → 返回内部用户 ID。
     * 契约 doctorLogin 要求"角色只能由服务端根据数据库中的任职关系判定"，必须先拿到身份再判角色，
     * 因此与签发会话拆开（不改变患者登录的对外行为）。
     */
    @Transactional
    public String loginIdentity(WechatLoginRequest request) {
        WechatSessionInfo session = wechatSessionProvider.getSessionByCode(request.code());
        if (session == null || session.openid() == null || session.openid().isBlank()) {
            throw new ApiException("WECHAT_CODE_INVALID", HttpStatus.UNPROCESSABLE_ENTITY,
                    "微信 code 换取会话失败，请重新登录");
        }
        Instant now = clock.instant();

        var user = userRepository.findByOpenid(session.openid())
                .orElseGet(() -> {
                    String id = "u-" + session.openid();
                    userRepository.insert(id, session.openid(),
                            session.nickname() == null ? "微信用户" : session.nickname(), now);
                    return userRepository.findById(id).orElseThrow();
                });
        profileRepository.findByUserId(user.id()).orElseGet(() -> {
            profileRepository.insert("up-" + user.id(), user.id(), now);
            return null;
        });

        // 契约手机号绑定路径：phoneCode（微信 getPhoneNumber 动态令牌），服务端解密并加密存储
        if (request.phoneCode() != null && !request.phoneCode().isBlank()) {
            applyPhone(user.id(), request.phoneCode(), null, now);
        }

        // F7 合规审计（2026-10-19）：记录本次登录携带的隐私政策版本（users.login_consent_version）。
        // 只记版本号用于审计；登录本身不写 consents 表——独立同意界面的语义由 consents 域承载。
        userRepository.recordLoginConsentVersion(user.id(), request.consentVersion(), now);

        return user.id();
    }

    /** GET /auth/session（契约外补充）：为当前用户签发一份新会话结构（与登录响应一致）。 */
    @Transactional
    public SessionData issueFreshSession(String userId) {
        return issueSession(userId);
    }

    /** 签发契约 Session（登录与 GET /auth/session 共用）。 */
    private SessionData issueSession(String userId) {
        // N10（2026-10-19）：注销冷静期内的账号不可再次登录（wechat/doctor 登录与 /auth/session 共用本收口）。
        var user = userRepository.findById(userId)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在"));
        if (!"ACTIVE".equals(user.status())) {
            throw new ApiException("ACCOUNT_DELETION_PENDING", HttpStatus.FORBIDDEN,
                    "账号已注销，处于 30 天冷静期；如需恢复请联系客服");
        }
        var issued = authSessionStore.issue(userId);
        return new SessionData(issued.accessToken(), issued.refreshToken(),
                AuthSessionStore.ACCESS_TTL_SECONDS, "Bearer", userService.contractUser(userId));
    }

    /**
     * 刷新令牌轮换（契约 refreshSession）：一次一换；已使用令牌再来 = 重放 → 401。
     * 长度/缺失不合规 → 400（契约声明 400）；未知/过期/撤销 → 401。
     */
    @Transactional
    public SessionData refresh(String refreshToken) {
        if (refreshToken == null || refreshToken.trim().isEmpty()) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "缺少 refreshToken");
        }
        if (refreshToken.trim().length() < 16) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.BAD_REQUEST,
                    "refreshToken 长度不足（契约 minLength 16）");
        }
        return authSessionStore.rotate(refreshToken.trim())
                .map(issued -> {
                    String owner = authSessionStore.resolveUserByAccessToken(issued.accessToken()).orElse(null);
                    if (owner == null) {
                        throw new ApiException("SESSION_REVOKED", HttpStatus.UNAUTHORIZED,
                                "刷新令牌无效、已轮换或会话已撤销，请重新登录");
                    }
                    return new SessionData(issued.accessToken(), issued.refreshToken(),
                            AuthSessionStore.ACCESS_TTL_SECONDS, "Bearer", userService.contractUser(owner));
                })
                .orElseThrow(() -> new ApiException("SESSION_REVOKED", HttpStatus.UNAUTHORIZED,
                        "刷新令牌无效、已轮换或会话已撤销，请重新登录"));
    }

    /**
     * 注销（契约 logout）：撤销当前请求所持 access token 的整条会话链。
     * 重复调用同样返回成功（幂等）；M1 占位鉴权下无令牌时如实返回 revoked=false（不伪造成功）。
     */
    @Transactional
    public boolean logout(String accessToken, String idempotencyKey) {
        // Idempotency-Key 必填由控制器校验（契约参数 required）；键本身不构成凭证
        if (accessToken == null || accessToken.isBlank()) {
            return false; // 无 Bearer：无会话可撤销，如实返回
        }
        return authSessionStore.revokeByAccessToken(accessToken);
    }

    /** 手机绑定（契约外 dev 便利路径；契约路径是 login.phoneCode，README 已标注）。 */
    @Transactional
    public PhoneBindResult bindPhone(String userId, PhoneBindRequest request) {
        var user = userRepository.findById(userId)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在"));
        if (request.phoneCode() == null && request.phone() == null) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "phoneCode 与 phone 至少提供一个");
        }
        Instant now = clock.instant();
        applyPhone(user.id(), request.phoneCode(), request.phone(), now);

        var fresh = userRepository.findById(user.id()).orElseThrow();
        String cipher = fresh.phoneCipher() == null ? null
                : new String(fresh.phoneCipher(), StandardCharsets.UTF_8);
        String last4 = cipher == null ? null : last4(cipher);
        return new PhoneBindResult(cipher, last4, true);
    }

    /** 解析并落库手机号：phoneCode（微信令牌）优先，dev 允许 phone 明文直传。 */
    private void applyPhone(String userId, String phoneCode, String phone, Instant now) {
        String plain;
        if (phoneCode != null && !phoneCode.isBlank()) {
            plain = wechatSessionProvider.getPhoneNumberByCode(phoneCode);
            if (plain == null) {
                throw new ApiException("PHONE_CODE_INVALID", HttpStatus.UNPROCESSABLE_ENTITY,
                        "手机号令牌无效或已过期");
            }
        } else {
            plain = phone;
        }
        if (!PhoneCrypto.isValidPhone(plain)) {
            throw new ApiException("PHONE_INVALID", HttpStatus.UNPROCESSABLE_ENTITY,
                    "手机号格式不正确（须为 11 位）");
        }
        String cipher = phoneCrypto.encrypt(plain);
        userRepository.bindPhone(userId, cipher.getBytes(StandardCharsets.UTF_8),
                Digests.sha256Hex(plain), now);
    }

    private String last4(String cipher) {
        try {
            String plain = phoneCrypto.decrypt(cipher);
            return plain.length() >= 4 ? plain.substring(plain.length() - 4) : plain;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 为 dev 联调生成一个稳定可用的用户 ID（dev 档 openid → id）。 */
    public static String stableUserId(String openid) {
        return "u-" + openid;
    }

    /** 供 Home/Catalog 复用：确保 dev 用户存在（无登录墙场景下 X-User-Id 可能是裸 openid）。 */
    @Transactional
    public String ensureUser(String userIdOrOpenid) {
        if (userIdOrOpenid == null || userIdOrOpenid.isBlank()) {
            throw new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在");
        }
        if (userRepository.findById(userIdOrOpenid).isPresent()) {
            return userIdOrOpenid;
        }
        // 允许直接传 openid（如 dev-user-1）
        var byOpenid = userRepository.findByOpenid(userIdOrOpenid);
        if (byOpenid.isPresent()) {
            return byOpenid.get().id();
        }
        String id = userIdOrOpenid.startsWith("u-") ? userIdOrOpenid : "u-" + userIdOrOpenid;
        if (userRepository.findById(id).isPresent()) {
            return id;
        }
        Instant now = clock.instant();
        // displayName 用中性默认名而非 openid（避免把 dev-user-1 之类身份字符串暴露给用户）；
        // 用户可在「个人信息 → 账号」改名（PUT /me/account）。
        userRepository.insert(id, userIdOrOpenid, "微信用户", now);
        profileRepository.insert("up-" + id, id, now);
        return id;
    }
}
