package com.wechar.biz.user;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.user.dto.AccountUpdateRequest;
import com.wechar.biz.user.dto.ExtendedProfileData;
import com.wechar.biz.user.dto.ExtendedProfileUpdateRequest;
import com.wechar.biz.user.dto.IdentityBindRequest;
import com.wechar.biz.user.dto.InsuranceBindRequest;
import com.wechar.biz.user.dto.PreferencesData;
import com.wechar.biz.user.dto.PreferencesUpdateRequest;
import com.wechar.biz.user.dto.ProfileData;
import com.wechar.biz.user.dto.ProfileUpdateRequest;
import com.wechar.biz.user.dto.UserData;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

/**
 * me 域控制器：
 *  GET /api/v1/me → OkUser（契约 User 形状，additionalProperties:false 九字段）；
 *  PATCH /me/profile、PUT /me/preferences 为契约外补充（契约 /me 仅 GET，README 已标注）；
 *  个人信息设置扩展（V8）：extended / identity / insurance / account / avatar。
 */
@RestController
@RequestMapping("/api/v1/me")
public class MeController {

    private final UserService userService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public MeController(UserService userService, AuthService authService, CurrentUserContext currentUserContext) {
        this.userService = userService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping
    public ResponseEntity<Envelope<UserData>> me() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.contractUser(userId)));
    }

    @PatchMapping("/profile")
    public ResponseEntity<Envelope<ProfileData>> updateProfile(@Valid @RequestBody ProfileUpdateRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.updateProfile(userId, request)));
    }

    @PutMapping("/preferences")
    public ResponseEntity<Envelope<PreferencesData>> updatePreferences(
            @Valid @RequestBody PreferencesUpdateRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.updatePreferences(userId, request)));
    }

    // ==================== 个人信息设置扩展（V8） ====================

    /** GET /me/extended：联系方式/住址明文 + 证件号/医保号掩码与绑定状态。 */
    @GetMapping("/extended")
    public ResponseEntity<Envelope<ExtendedProfileData>> extended() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.getExtendedProfile(userId)));
    }

    /** PUT /me/extended：邮箱/住宅/户籍更新（null 保留原值）。 */
    @PutMapping("/extended")
    public ResponseEntity<Envelope<ExtendedProfileData>> updateExtended(
            @Valid @RequestBody ExtendedProfileUpdateRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.updateExtendedProfile(userId, request)));
    }

    /** POST /me/identity：身份证实名绑定（写操作，幂等键由调用方携带）。 */
    @PostMapping("/identity")
    public ResponseEntity<Envelope<ExtendedProfileData>> bindIdentity(
            @Valid @RequestBody IdentityBindRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.bindIdentity(userId, request)));
    }

    /** POST /me/insurance：医保绑定。 */
    @PostMapping("/insurance")
    public ResponseEntity<Envelope<ExtendedProfileData>> bindInsurance(
            @Valid @RequestBody InsuranceBindRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.bindInsurance(userId, request)));
    }

    /** PUT /me/account：改名（同步影响契约 /me 与登录态显示；前端统一封装只有 get/post/put/del）。 */
    @PutMapping("/account")
    public ResponseEntity<Envelope<UserData>> updateAccount(@Valid @RequestBody AccountUpdateRequest request) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.updateAccount(userId, request)));
    }

    /** POST /me/avatar：multipart 上传（part 名 "file"），返回更新后的契约 User。 */
    @PostMapping("/avatar")
    public ResponseEntity<Envelope<UserData>> updateAvatar(@RequestPart("file") MultipartFile file) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), userService.updateAvatar(userId, file)));
    }
}
