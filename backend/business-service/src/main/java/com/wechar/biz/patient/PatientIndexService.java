package com.wechar.biz.patient;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.common.IdCards;
import com.wechar.biz.common.PhoneHashing;
import com.wechar.biz.patient.dto.PatientCreateRequest;
import com.wechar.biz.patient.dto.PatientData;
import com.wechar.biz.patient.dto.PatientMappingData;
import com.wechar.biz.patient.dto.PatientUpdateRequest;
import java.time.Clock;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 就诊人主索引（P3 病历/报告前置，2026-11-27）。
 *
 * <p>解决的问题：平台此前对 HIS 只有「姓名」一个身份字段，HIS 用 sha256(appId|姓名) 派生
 * DEMO- MRN —— 同名即串号、改名即另起一档，报告无法安全归属到「就诊人」。
 * 这里给每个就诊人一个稳定 ref（pat- + UUIDv4），受理时下发给 HIS 换稳定档案。</p>
 *
 * <p>三条硬约束（owner 2026-11-27 定稿，改动需同步契约文档）：</p>
 * <ol>
 *   <li>归属只认服务端 userId：任何请求体里的 owner 字段按未知字段 422，绝不采信；</li>
 *   <li>ref 不含业务语义、不可推导：随机 UUIDv4，客户端不得解析，日志只记 sha256[:16]；</li>
 *   <li>证件号明文不落库：只存 HIS 兼容口径哈希 + 尾 4 位；校验位不通过则连哈希都不写。</li>
 * </ol>
 *
 * <p>开关：{@code app.patient-index.enabled}（默认 false）。关闭时 Controller 返回 404，
 * 预约与报告仍走旧链路 —— 这是本功能的回滚手段。</p>
 */
@Service
public class PatientIndexService {

    private static final Logger log = LoggerFactory.getLogger(PatientIndexService.class);

    private final PatientIndexRepository repository;
    private final FamilyRepository familyRepository;
    private final PhoneHashing phoneHashing;
    private final Clock clock;
    private final boolean enabled;
    private final String hisPatientHashSalt;

    public PatientIndexService(PatientIndexRepository repository,
                               FamilyRepository familyRepository,
                               PhoneHashing phoneHashing,
                               Clock clock,
                               @Value("${app.patient-index.enabled:false}") boolean enabled,
                               @Value("${app.his.patient-hash-salt:}") String hisPatientHashSalt) {
        this.repository = repository;
        this.familyRepository = familyRepository;
        this.phoneHashing = phoneHashing;
        this.clock = clock;
        this.enabled = enabled;
        this.hisPatientHashSalt = hisPatientHashSalt == null ? "" : hisPatientHashSalt.trim();
        if (enabled && this.hisPatientHashSalt.isEmpty()) {
            log.warn("APP_HIS_PATIENT_HASH_SALT 未配置：就诊人证件哈希不落库，跨端 T1 匹配不可用"
                    + "（其余功能不受影响；上线前必须与 HIS 侧 CLINIC_PATIENT_HASH_SALT 配成同一值）");
        }
    }

    public boolean isEnabled() {
        return enabled;
    }

    // ------------------------------------------------------------ 查询

    @Transactional(readOnly = true)
    public List<PatientData> list(String userId, boolean includeArchived) {
        return repository.listByOwner(userId, includeArchived).stream()
                .map(row -> toData(row, null))
                .toList();
    }

    @Transactional(readOnly = true)
    public PatientData get(String userId, String patientRef) {
        return toData(requireOwned(userId, patientRef), null);
    }

    @Transactional(readOnly = true)
    public PatientMappingData mapping(String userId, String patientRef) {
        var row = requireOwned(userId, patientRef);
        var mapping = repository.findMapping(patientRef);
        String linkState = linkState(row, mapping);
        return new PatientMappingData(linkState,
                mapping.map(PatientIndexRepository.MappingRow::matchTier).orElse(null),
                false,
                mapping.map(PatientIndexRepository.MappingRow::decidedAt).orElse(null),
                mapping.map(PatientIndexRepository.MappingRow::updatedAt).orElse(null));
    }

    // ------------------------------------------------------------ 建档

    @Transactional
    public PatientData create(String userId, String idempotencyKey, PatientCreateRequest request) {
        String displayName = request.displayName() == null ? "" : request.displayName().trim();
        if (displayName.isEmpty()) {
            throw validation("displayName", "姓名不能为空");
        }
        String familyMemberId = blankToNull(request.familyMemberId());
        if (familyMemberId != null) {
            // 「添加家人」≠「获权代操作」，但建档只需要成员归属，不需要 proxyStatus=GRANTED
            familyRepository.findMember(userId, familyMemberId)
                    .orElseThrow(() -> new ApiException("FAMILY_MEMBER_FORBIDDEN", HttpStatus.FORBIDDEN,
                            "家庭成员不存在或不属于当前用户"));
        }

        String idNumber = normalizeId(request.idCardNumber());
        String idHash = idHashOf(idNumber);
        String idLast4 = idNumber.isEmpty() ? "" : IdCards.last4(idNumber);
        String phone = blankToNull(request.phone());
        String phoneHash = phone == null ? "" : phoneHashing.hash(phone);
        String phoneMask = phone == null ? "" : maskPhone(phone);
        // 核验等级只看「有没有可用于匹配的更强字段」：有证件=ID_VERIFIED；只有生日/性别/手机=PROFILE；都没有=NONE
        String verification;
        if (!idNumber.isEmpty()) {
            verification = "ID_VERIFIED";
        } else if (request.birthDate() != null || request.sex() != null || phone != null) {
            verification = "PROFILE";
        } else {
            verification = "NONE";
        }

        String digest = Digests.sha256Hex(canonical(displayName, familyMemberId, request.birthDate(),
                request.sex(), idNumber, phone));

        // (a) 幂等：同键同摘要返回原记录；同键异摘要 409
        var priorDigest = repository.findIdempotencyDigest(userId, idempotencyKey);
        if (priorDigest.isPresent()) {
            if (!priorDigest.get().equals(digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
            }
            return repository.findByName(userId, displayName)
                    .map(row -> toData(row, Boolean.FALSE))
                    .orElseThrow(PatientIndexService::throwNotFound);
        }

        // (b) 同用户同姓名 → 返回既有（V39 唯一键就是 (owner_user_id, display_name)）
        Optional<PatientIndexRepository.PatientRow> sameName = repository.findByName(userId, displayName);
        if (sameName.isPresent()) {
            return toData(sameName.get(), Boolean.FALSE);
        }

        // (c) 同一证件不允许建两个就诊人
        if (!idHash.isEmpty()) {
            repository.findByOwnerAndIdHash(userId, idHash).ifPresent(existing -> {
                throw new ApiException("ID_HASH_CONFLICT", HttpStatus.CONFLICT,
                        "该证件号已建档为其它就诊人", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "idCardNumber", "同证件号已存在就诊人档案", "ID_HASH_CONFLICT")));
            });
        }

        Instant now = clock.instant();
        var row = new PatientIndexRepository.PatientRow(
                newPatientRef(), userId, familyMemberId, displayName,
                blankToNull(request.birthDate()), blankToNull(request.sex()), idLast4,
                idHash, phoneMask, phoneHash, verification, "USER_INPUT", "ACTIVE", 1, now, null);
        repository.insert(row, idempotencyKey, digest);
        log.info("就诊人建档 ref={} user={} verified={}", logRef(row.patientRef()), userId, verification);
        return toData(row, Boolean.TRUE);
    }

    // ------------------------------------------------------------ 修改

    @Transactional
    public PatientData update(String userId, String patientRef, PatientUpdateRequest request) {
        var row = requireOwned(userId, patientRef);
        if ("ARCHIVED".equals(row.status())) {
            throw new ApiException("PATIENT_ARCHIVED", HttpStatus.CONFLICT,
                    "该就诊人已归档，不能修改；如需继续使用请新建就诊人");
        }
        if (row.version() != request.version()) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "就诊人信息已被更新，请刷新后重试", true,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "version", "期望版本 " + row.version() + "，请求 " + request.version(),
                            "VERSION_CONFLICT")));
        }

        String displayName = request.displayName() == null ? row.displayName() : request.displayName().trim();
        if (displayName.isEmpty()) {
            throw validation("displayName", "姓名不能为空");
        }
        if (!displayName.equals(row.displayName())) {
            // 改名不换 ref；但同用户已有同名档案时不允许合并成重复行（唯一键会抛，这里先给人话）
            var sameName = repository.findByName(userId, displayName);
            if (sameName.isPresent() && !sameName.get().patientRef().equals(patientRef)) {
                throw new ApiException("PATIENT_NAME_EXISTS", HttpStatus.CONFLICT,
                        "已存在同名就诊人，请改用其它姓名或直接使用既有档案");
            }
        }

        String birthDate = request.birthDate() == null ? row.birthDate() : blankToNull(request.birthDate());
        String sex = request.sex() == null ? row.sex() : blankToNull(request.sex());

        String idLast4 = row.idLast4();
        String idHash = row.idCardHash();
        String verification = row.verificationLevel();
        if (request.idCardNumber() != null) {
            String idNumber = normalizeId(request.idCardNumber());
            if (!idNumber.isEmpty()) {
                idLast4 = IdCards.last4(idNumber);
                idHash = idHashOf(idNumber);
                verification = "ID_VERIFIED";
                String finalHash = idHash;
                repository.findByOwnerAndIdHash(userId, finalHash).ifPresent(existing -> {
                    if (!existing.equals(patientRef)) {
                        throw new ApiException("ID_HASH_CONFLICT", HttpStatus.CONFLICT,
                                "该证件号已建档为其它就诊人");
                    }
                });
            }
        }

        String phoneMask = row.phoneMask();
        String phoneHash = row.phoneHash();
        if (request.phone() != null) {
            String phone = blankToNull(request.phone());
            phoneMask = phone == null ? null : maskPhone(phone);
            phoneHash = phone == null ? null : phoneHashing.hash(phone);
        }

        boolean updated = repository.updateWithVersion(userId, patientRef, request.version(),
                displayName, birthDate, sex, idLast4, idHash, phoneMask, phoneHash, verification);
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "就诊人信息已被更新，请刷新后重试", true, null);
        }
        return toData(requireOwned(userId, patientRef), null);
    }

    // ------------------------------------------------------------ 归档

    @Transactional
    public PatientData archive(String userId, String patientRef) {
        var row = requireOwned(userId, patientRef);
        if ("ARCHIVED".equals(row.status())) {
            return toData(row, null);   // 幂等：重复归档按成功返回
        }
        List<String> blocking = safeBlockingAppointments(patientRef);
        if (!blocking.isEmpty()) {
            throw new ApiException("PATIENT_IN_USE", HttpStatus.CONFLICT,
                    "该就诊人还有未完成的预约，请先完成或取消后再归档", false,
                    blocking.stream().map(id -> new GlobalExceptionHandler.ErrorDetail(
                            "appointmentId", id, "PATIENT_IN_USE")).toList());
        }
        repository.archive(userId, patientRef);
        return toData(requireOwned(userId, patientRef), null);
    }

    // ------------------------------------------------------------ 内部

    private PatientIndexRepository.PatientRow requireOwned(String userId, String patientRef) {
        return repository.findOwned(userId, patientRef)
                .orElseThrow(() -> new ApiException("PATIENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "就诊人不存在"));   // 与「无权」同响应，避免对象存在性泄漏
    }

    private PatientData toData(PatientIndexRepository.PatientRow row, Boolean created) {
        return new PatientData(
                row.patientRef(), row.displayName(), relationOf(row), row.familyMemberId(),
                row.birthDate(), row.sex(), IdCards.mask(row.idLast4()), row.phoneMask(),
                row.verificationLevel(), row.status(), linkState(row, repository.findMapping(row.patientRef())),
                row.version(), created, row.createdAt(), row.updatedAt());
    }

    /**
     * linkState 口径：
     * ARCHIVED（已归档）> CONFLICT（同名多档待裁决）> LINKED（投影 CONFIRMED）
     * > LINKED_PROJECTION_PENDING（事实源已连、投影待补，读取不受影响）> PENDING。
     */
    private String linkState(PatientIndexRepository.PatientRow row,
                             Optional<PatientIndexRepository.MappingRow> mapping) {
        if ("ARCHIVED".equals(row.status())) {
            return "ARCHIVED";
        }
        if (mapping.isPresent()) {
            String status = mapping.get().status();
            if ("CONFIRMED".equals(status)) {
                return "LINKED";
            }
            if ("CONFLICT".equals(status)) {
                return "CONFLICT";
            }
        }
        return safeHasLinkedAppointment(row.patientRef()) ? "LINKED_PROJECTION_PENDING" : "PENDING";
    }

    /** V41 未迁移的库没有 patient_ref 列：此时按「尚未连」处理，不让列表整页 500。 */
    private boolean safeHasLinkedAppointment(String patientRef) {
        try {
            return repository.hasLinkedAppointment(patientRef);
        } catch (RuntimeException e) {
            log.debug("appointments.patient_ref 不可用（V41 未迁移）：{}", e.getMessage());
            return false;
        }
    }

    private List<String> safeBlockingAppointments(String patientRef) {
        try {
            return repository.listBlockingAppointments(patientRef);
        } catch (RuntimeException e) {
            log.debug("appointments.patient_ref 不可用（V41 未迁移），跳过归档占用校验：{}", e.getMessage());
            return List.of();
        }
    }

    private static String relationOf(PatientIndexRepository.PatientRow row) {
        if (row.familyMemberId() == null || row.familyMemberId().isBlank()) {
            return "SELF";
        }
        return "FAMILY";
    }

    /** 新 ref：pat- + UUIDv4 去连字符（32 位小写 hex），随机、不可推导。 */
    private static String newPatientRef() {
        return "pat-" + UUID.randomUUID().toString().replace("-", "");
    }

    private String normalizeId(String raw) {
        if (raw == null || raw.isBlank()) {
            return "";
        }
        String v = raw.trim().toUpperCase(Locale.ROOT);
        if (!IdCards.isValid(v)) {
            throw new ApiException("INVALID_ID_CARD", HttpStatus.UNPROCESSABLE_ENTITY,
                    "身份证号校验未通过，请核对后重试", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "idCardNumber", "18 位号码或校验位不正确", "INVALID_ID_CARD")));
        }
        return v;
    }

    /**
     * 证件哈希必须与 HIS 同口径：sha256(salt + 证件号)。
     *
     * <p>平台自身的 {@code user_extended.id_card_hash} 是**无盐** sha256，
     * 与 HIS 加盐值永不相等 —— 直接拿来比对会让 T1 匹配命中率恒为 0（2026-11-27 实测）。
     * 未配置盐时返回空串（宁可不匹配，也不写一个对不上的值）。</p>
     */
    private String idHashOf(String idNumber) {
        if (idNumber == null || idNumber.isEmpty()) {
            return "";
        }
        if (hisPatientHashSalt.isEmpty()) {
            return "";
        }
        return Digests.sha256Hex(hisPatientHashSalt + idNumber);
    }

    private static String maskPhone(String phone) {
        return phone.length() >= 7 ? phone.substring(0, 3) + "****" + phone.substring(phone.length() - 4)
                : "****";
    }

    private static String canonical(String displayName, String familyMemberId, String birthDate,
                                    String sex, String idNumber, String phone) {
        List<String> parts = new ArrayList<>();
        parts.add("name=" + displayName);
        parts.add("fm=" + (familyMemberId == null ? "" : familyMemberId));
        parts.add("birth=" + (birthDate == null ? "" : birthDate.trim()));
        parts.add("sex=" + (sex == null ? "" : sex.trim()));
        parts.add("id=" + (idNumber == null ? "" : idNumber));
        parts.add("phone=" + (phone == null ? "" : phone));
        return String.join("|", parts);
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    private static ApiException validation(String field, String reason) {
        return new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, reason, false,
                List.of(new GlobalExceptionHandler.ErrorDetail(field, reason, "VALIDATION_FAILED")));
    }

    private static ApiException throwNotFound() {
        return new ApiException("PATIENT_NOT_FOUND", HttpStatus.NOT_FOUND, "就诊人不存在");
    }

    /** 日志脱敏（C3-③）：只允许 16 位摘要，不落 ref 原文。 */
    public static String logRef(String patientRef) {
        return patientRef == null ? "-" : Digests.sha256Hex(patientRef).substring(0, 16);
    }
}
