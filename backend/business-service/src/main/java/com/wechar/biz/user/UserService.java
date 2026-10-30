package com.wechar.biz.user;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.consent.ConsentRepository;
import com.wechar.biz.crypto.PhoneCrypto;
import com.wechar.biz.doctor.DoctorRepository;
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
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.multipart.MultipartFile;

/**
 * me 域服务：
 *  - contractUser：契约 User（OkUser/Session.user 共用；additionalProperties:false 严格九字段内）；
 *  - GET /me 直接返回契约 User（OkUser）；
 *  - PATCH /me/profile、PUT /me/preferences 为任务书补充路径（契约 /me 仅 GET，README 已标注）；
 *  - 个人信息设置扩展（V8）：GET/PUT /me/extended、POST /me/identity、POST /me/insurance、
 *    PATCH /me/account、POST /me/avatar —— 证件号/医保号 AES-GCM 密文落库，响应只给掩码。
 */
@Service
public class UserService {

    /** 身份证校验码权重与映射（GB 11643-1999）。 */
    private static final int[] ID_WEIGHTS = {7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2};
    private static final String ID_CHECK_CHARS = "10X98765432";

    private final UserRepository userRepository;
    private final ProfileRepository profileRepository;
    private final PreferenceRepository preferenceRepository;
    private final ExtendedProfileRepository extendedRepository;
    private final DoctorRepository doctorRepository;
    private final ConsentRepository consentRepository;
    private final PhoneCrypto phoneCrypto;
    private final AvatarStorage avatarStorage;
    private final Clock clock;

    public UserService(UserRepository userRepository, ProfileRepository profileRepository,
                       PreferenceRepository preferenceRepository, ExtendedProfileRepository extendedRepository,
                       DoctorRepository doctorRepository,
                       ConsentRepository consentRepository, PhoneCrypto phoneCrypto,
                       AvatarStorage avatarStorage, Clock clock) {
        this.userRepository = userRepository;
        this.profileRepository = profileRepository;
        this.preferenceRepository = preferenceRepository;
        this.extendedRepository = extendedRepository;
        this.doctorRepository = doctorRepository;
        this.consentRepository = consentRepository;
        this.phoneCrypto = phoneCrypto;
        this.avatarStorage = avatarStorage;
        this.clock = clock;
    }

    /**
     * 契约 User 对象（登录 Session.user 与 GET /me 共用）：9 字段严格对齐，绝不附加。
     * roles 只能由服务端认定（契约 User.roles："客户端不得据此以外的来源做权限判断"）：
     * PATIENT 恒有；命中 doctors.user_id 任职关系（status=ACTIVE）时追加 DOCTOR。
     */
    @Transactional // 非只读：首次访问需补建 user_preferences 默认行（/me 兼顾），consents 只读
    public UserData contractUser(String userId) {
        var user = userRepository.findById(userId)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在"));
        preferenceRepository.insertIfAbsent(userId, clock.instant()); // 首次访问补默认行
        List<Map<String, Object>> consents = consentRepository.listFor(userId);
        List<String> roles = new ArrayList<>();
        roles.add("PATIENT");
        if (doctorRepository.hasActiveDoctor(userId)) {
            roles.add("DOCTOR");
        }
        var profile = profileRepository.findByUserId(userId).orElse(null);
        String gender = genderOf(profile == null ? null : profile.sex());
        var birthDate = profile == null ? null : profile.birthDate();
        return new UserData(user.id(), user.displayName(), avatarUrlOf(user.avatarKey()), gender, birthDate,
                profileCompleteness(userId), roles, user.phoneBound(), maskedPhone(user), new ArrayList<Object>(consents),
                user.createdAt(), user.updatedAt());
    }

    /**
     * F8（2026-10-19）：脱敏手机号 138****1234（个人信息页展示）。
     * 未绑定 / 密文缺失 / 密钥轮换导致解密失败 → null（NON_NULL 下字段省略，前端不渲染）；
     * 原文永不出服务端。
     */
    private String maskedPhone(UserRepository.UserRow user) {
        if (!user.phoneBound() || user.phoneCipher() == null) {
            return null;
        }
        try {
            String plain = phoneCrypto.decrypt(new String(user.phoneCipher(), StandardCharsets.UTF_8));
            return plain != null && plain.length() == 11
                    ? plain.substring(0, 3) + "****" + plain.substring(7) : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * 性别归一：库内 sex 为自由文本（历史数据可能有 M/男/F/女），对外恒为 MALE/FEMALE/UNKNOWN。
     * 契约 User.gender 是枚举，客户端不得因未知值崩溃 —— 未知一律 UNKNOWN。
     */
    private static String genderOf(String sex) {
        if (sex == null || sex.isBlank()) {
            return "UNKNOWN";
        }
        String value = sex.trim().toUpperCase(java.util.Locale.ROOT);
        if (value.equals("MALE") || value.equals("M") || value.equals("男") || value.equals("1")) {
            return "MALE";
        }
        if (value.equals("FEMALE") || value.equals("F") || value.equals("女") || value.equals("2")) {
            return "FEMALE";
        }
        return "UNKNOWN";
    }

    /** 头像只下发可直接加载的 URL：完整 http(s) 或站内相对路径（客户端拼网关前缀）。 */
    private static String avatarUrlOf(String avatarKey) {
        if (avatarKey == null || avatarKey.isBlank()) {
            return null;
        }
        if (avatarKey.startsWith("http://") || avatarKey.startsWith("https://") || avatarKey.startsWith("/")) {
            return avatarKey;
        }
        return null;
    }

    // ==================== 个人信息设置扩展（V8） ====================

    /** GET /me/extended：首次访问补默认行；证件号/医保号解密取数后仅回掩码，原文不出服务端。 */
    @Transactional
    public ExtendedProfileData getExtendedProfile(String userId) {
        extendedRepository.insertIfAbsent(userId, clock.instant());
        var row = extendedRepository.findByUserId(userId).orElseThrow();
        String idMasked = null;
        if (row.idCardCipher() != null) {
            try {
                String base64 = new String(row.idCardCipher(), StandardCharsets.UTF_8);
                idMasked = maskIdCard(phoneCrypto.decrypt(base64));
            } catch (Exception e) {
                idMasked = null; // 密钥轮换等极端场景：宁可不显示掩码，也不泄露/不 500
            }
        }
        String insuranceMasked = null;
        if (row.insuranceNoCipher() != null) {
            try {
                String base64 = new String(row.insuranceNoCipher(), StandardCharsets.UTF_8);
                insuranceMasked = maskInsuranceNo(phoneCrypto.decrypt(base64));
            } catch (Exception e) {
                insuranceMasked = null;
            }
        }
        return new ExtendedProfileData(row.email(), row.residence(), row.householdRegistration(),
                row.idCardName(), idMasked, row.idCardVerified(),
                row.insuranceType(), insuranceMasked, row.insuranceBound(), row.version());
    }

    /** PUT /me/extended：null 字段保留原值（部分更新语义）。 */
    @Transactional
    public ExtendedProfileData updateExtendedProfile(String userId, ExtendedProfileUpdateRequest request) {
        extendedRepository.insertIfAbsent(userId, clock.instant());
        extendedRepository.updateContact(userId, request.email(), request.residence(),
                request.householdRegistration(), clock.instant());
        return getExtendedProfile(userId);
    }

    /** POST /me/identity：身份证实名绑定（GB 11643 校验码验证 → 密文落库）。 */
    @Transactional
    public ExtendedProfileData bindIdentity(String userId, IdentityBindRequest request) {
        String idNumber = request.idCardNumber() == null ? "" : request.idCardNumber().trim().toUpperCase(Locale.ROOT);
        if (!isValidIdCard(idNumber)) {
            throw new ApiException("INVALID_ID_CARD", HttpStatus.UNPROCESSABLE_ENTITY,
                    "身份证号校验未通过，请核对后重试");
        }
        String name = request.name().trim();
        extendedRepository.insertIfAbsent(userId, clock.instant());
        extendedRepository.bindIdCard(userId, name,
                phoneCrypto.encrypt(idNumber).getBytes(StandardCharsets.UTF_8), sha256Hex(idNumber),
                clock.instant());
        return getExtendedProfile(userId);
    }

    /** POST /me/insurance：医保绑定（号码密文落库，类型受枚举约束）。 */
    @Transactional
    public ExtendedProfileData bindInsurance(String userId, InsuranceBindRequest request) {
        String insuranceNo = request.insuranceNo().trim().toUpperCase(Locale.ROOT);
        extendedRepository.insertIfAbsent(userId, clock.instant());
        extendedRepository.bindInsurance(userId, request.insuranceType(),
                phoneCrypto.encrypt(insuranceNo).getBytes(StandardCharsets.UTF_8), sha256Hex(insuranceNo),
                clock.instant());
        return getExtendedProfile(userId);
    }

    /** PATCH /me/account：改名（users.display_name，同步影响契约 /me）。 */
    @Transactional
    public UserData updateAccount(String userId, AccountUpdateRequest request) {
        userRepository.findById(userId)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在"));
        userRepository.updateDisplayName(userId, request.displayName().trim(), clock.instant());
        return contractUser(userId);
    }

    /** POST /me/avatar：multipart 上传 → 本地存储 → avatar_key 落相对路径。 */
    @Transactional
    public UserData updateAvatar(String userId, MultipartFile file) {
        String path = avatarStorage.save(file);
        userRepository.findById(userId)
                .orElseThrow(() -> new ApiException("USER_NOT_FOUND", HttpStatus.NOT_FOUND, "用户不存在"));
        userRepository.updateAvatarKey(userId, path, clock.instant());
        return contractUser(userId);
    }

    /** 身份证号校验：18 位 + 前 17 位数字 + 校验码（GB 11643）。 */
    private static boolean isValidIdCard(String id) {
        if (id == null || id.length() != 18) {
            return false;
        }
        int sum = 0;
        for (int i = 0; i < 17; i++) {
            char c = id.charAt(i);
            if (c < '0' || c > '9') {
                return false;
            }
            sum += (c - '0') * ID_WEIGHTS[i];
        }
        char last = id.charAt(17);
        if (!(last >= '0' && last <= '9') && last != 'X') {
            return false;
        }
        return ID_CHECK_CHARS.charAt(sum % 11) == last;
    }

    /** 证件号掩码：前 4 位 + 定长星号 + 后 4 位。 */
    private static String maskIdCard(String id) {
        if (id == null || id.length() < 8) {
            return null;
        }
        return id.substring(0, 4) + "**********" + id.substring(id.length() - 4);
    }

    /** 医保号掩码：恒 "****" + 末 4 位。 */
    private static String maskInsuranceNo(String no) {
        if (no == null || no.length() < 4) {
            return null;
        }
        return "****" + no.substring(no.length() - 4);
    }

    private static String sha256Hex(String value) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (Exception e) {
            throw new IllegalStateException("SHA-256 不可用", e);
        }
    }

    /** PATCH /me/profile：version 必填校验交给调用层（任务书规则 5 的乐观锁）。 */
    @Transactional
    public ProfileData updateProfile(String userId, ProfileUpdateRequest request) {
        if (request.version() == null) {
            throw new ApiException("VERSION_REQUIRED", HttpStatus.BAD_REQUEST, "缺少必需字段 version（乐观锁）");
        }
        var profile = profileRepository.findByUserId(userId)
                .orElseThrow(() -> new ApiException("PROFILE_NOT_FOUND", HttpStatus.NOT_FOUND, "档案不存在"));
        boolean updated = profileRepository.update(profile.id(), request.version(),
                request.birthDate() != null ? request.birthDate() : profile.birthDate(),
                request.sex() != null ? request.sex() : profile.sex(),
                request.heightCm() != null ? request.heightCm() : profile.heightCm(),
                request.weightKg() != null ? request.weightKg() : profile.weightKg(),
                request.allergies() != null ? request.allergies() : profile.allergies(),
                request.chronicConditions() != null ? request.chronicConditions() : profile.chronicConditions(),
                clock.instant());
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "档案已被其他请求修改，请刷新后重试");
        }
        var fresh = profileRepository.findByUserId(userId).orElseThrow();
        return new ProfileData(fresh.birthDate(), fresh.sex(), fresh.heightCm(), fresh.weightKg(),
                fresh.allergies(), fresh.chronicConditions(), fresh.version(), fresh.updatedAt());
    }

    /** PUT /me/preferences：整体覆盖提供的字段（缺省字段保留原值/默认值）。 */
    @Transactional
    public PreferencesData updatePreferences(String userId, PreferencesUpdateRequest request) {
        preferenceRepository.insertIfAbsent(userId, clock.instant());
        var current = preferenceRepository.findByUserId(userId).orElseThrow();
        int expected = request.version() != null ? request.version() : current.version();
        boolean updated = preferenceRepository.update(userId, expected,
                request.locale() != null ? request.locale() : current.locale(),
                request.themeMode() != null ? request.themeMode() : current.themeMode(),
                request.fontScale() != null ? request.fontScale() : current.fontScale(),
                request.ttsRate() != null ? request.ttsRate() : current.ttsRate(),
                request.ttsAutoPlay() != null ? request.ttsAutoPlay() : current.ttsAutoPlay(),
                clock.instant());
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "偏好已被其他请求修改，请刷新后重试");
        }
        var fresh = preferenceRepository.findByUserId(userId).orElseThrow();
        return new PreferencesData(fresh.locale(), fresh.themeMode(), fresh.fontScale(),
                fresh.ttsRate(), fresh.ttsAutoPlay(), fresh.version());
    }

    /** 档案完整度（0~100，仅引导用）：按已填字段数计算，无猜测。 */
    private int profileCompleteness(String userId) {
        var p = profileRepository.findByUserId(userId);
        if (p.isEmpty()) {
            return 0;
        }
        var row = p.get();
        int filled = 0;
        int total = 6;
        if (row.birthDate() != null) filled++;
        if (row.sex() != null && !row.sex().isBlank()) filled++;
        if (row.heightCm() != null) filled++;
        if (row.weightKg() != null) filled++;
        if (row.allergies() != null && !row.allergies().isBlank()) filled++;
        if (row.chronicConditions() != null && !row.chronicConditions().isBlank()) filled++;
        return filled * 100 / total;
    }
}
