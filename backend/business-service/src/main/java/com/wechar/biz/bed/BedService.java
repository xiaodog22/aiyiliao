package com.wechar.biz.bed;

import com.wechar.biz.bed.dto.BedAssignmentRequest;
import com.wechar.biz.bed.dto.BedData;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.doctor.DoctorRepository;
import com.wechar.biz.doctor.DoctorService;
import com.wechar.biz.user.UserRepository;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 床位服务（契约 beds 域，M3）：
 *  - listBeds：范围 = 医生任职科室下的 ACTIVE 病区（ward_id 白名单进 SQL），显式指定越权病区 → 403；
 *  - assignBed：五动作状态机 + expectedVersion 乐观锁 + Idempotency-Key；
 *    ASSIGN 只接受**内部患者 ID**（patientRef），姓名/手机号一律 422（契约明文）。
 *
 * 动作可行性（M3 口径，登记于任务回执：契约只给动作枚举与"乐观锁 + 唯一约束裁决"）：
 *   AVAILABLE      → ASSIGN / RESERVE / SET_CLEANING / SET_OUT_OF_SERVICE
 *   RESERVED       → ASSIGN / RELEASE / SET_CLEANING / SET_OUT_OF_SERVICE
 *   OCCUPIED       → RELEASE / SET_CLEANING / SET_OUT_OF_SERVICE
 *   CLEANING       → SET_OUT_OF_SERVICE
 *   OUT_OF_SERVICE → SET_CLEANING
 */
@Service
public class BedService {

    private static final Set<String> ACTIONS =
            Set.of("ASSIGN", "RELEASE", "RESERVE", "SET_CLEANING", "SET_OUT_OF_SERVICE");

    private static final Map<String, Set<String>> ALLOWED = Map.of(
            "AVAILABLE", Set.of("ASSIGN", "RESERVE", "SET_CLEANING", "SET_OUT_OF_SERVICE"),
            "RESERVED", Set.of("ASSIGN", "RELEASE", "SET_CLEANING", "SET_OUT_OF_SERVICE"),
            "OCCUPIED", Set.of("RELEASE", "SET_CLEANING", "SET_OUT_OF_SERVICE"),
            "CLEANING", Set.of("SET_OUT_OF_SERVICE"),
            "OUT_OF_SERVICE", Set.of("SET_CLEANING"));

    private static final Map<String, String> ACTION_TARGET = Map.of(
            "ASSIGN", "OCCUPIED",
            "RELEASE", "AVAILABLE",
            "RESERVE", "RESERVED",
            "SET_CLEANING", "CLEANING",
            "SET_OUT_OF_SERVICE", "OUT_OF_SERVICE");

    private final BedRepository bedRepository;
    private final DoctorService doctorService;
    private final UserRepository userRepository;
    private final Clock clock;

    public BedService(BedRepository bedRepository, DoctorService doctorService,
                      UserRepository userRepository, Clock clock) {
        this.bedRepository = bedRepository;
        this.doctorService = doctorService;
        this.userRepository = userRepository;
        this.clock = clock;
    }

    /** 契约 listBeds：wardId 显式越权 → 403（该路径契约声明 403）；status 作为筛选条件按原值匹配。 */
    @Transactional(readOnly = true)
    public List<BedData> list(String userId, String wardId, String status) {
        DoctorRepository.DoctorRow doctor = doctorService.requireDoctor(userId);
        List<String> wardIds = bedRepository.listAuthorizedWardIds(doctor.departmentId());
        if (wardId != null && !wardId.isBlank() && !wardIds.contains(wardId)) {
            throw new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN,
                    "该病区不在当前医生的授权范围内");
        }
        return bedRepository.listBeds(wardIds, wardId, status).stream().map(BedService::toData).toList();
    }

    /** 契约 assignBed：变更床位分配；并发冲突由乐观锁 + 唯一约束裁决。 */
    @Transactional
    public BedData assign(String userId, String bedId, String idempotencyKey, BedAssignmentRequest request) {
        DoctorRepository.DoctorRow doctor = doctorService.requireDoctor(userId);
        String action = request.action();
        if (!ACTIONS.contains(action)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "action 取值不在 BedAssignmentRequest 枚举内，不得臆造动作");
        }

        BedRepository.BedRow bed = bedRepository.findBed(bedId)
                .filter(b -> doctor.departmentId().equals(
                        bedRepository.findBedDepartmentId(b.id()).orElse(null)))
                .orElseThrow(() -> new ApiException("BED_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "床位不存在或不属于当前医生的授权病区"));

        String digest = Digests.sha256Hex(canonical(request));

        // 幂等：以该床位"最近一次分配操作"的键与摘要判定（同键同载荷 → 返回当前资源；同键异载荷 → 409）
        if (idempotencyKey.equals(bed.lastIdempotencyKey())) {
            if (digest.equals(bed.lastRequestDigest())) {
                return toData(bed);
            }
            throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                    "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
        }

        if (!ALLOWED.getOrDefault(bed.status(), Set.of()).contains(action)) {
            throw new ApiException("BED_STATE_CONFLICT", HttpStatus.CONFLICT,
                    "当前床位状态（" + bed.status() + "）不允许执行 " + action, false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "action", "状态 " + bed.status() + " 不允许 " + action, "BED_STATE_CONFLICT")));
        }

        Instant now = clock.instant();
        String occupantUserId = null;
        String occupantDisplayName = null;
        Instant admittedAt = null;
        if ("ASSIGN".equals(action)) {
            String patientRef = request.patientRef();
            if (patientRef == null || patientRef.isBlank()) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "ASSIGN 动作必须提供 patientRef（内部患者 ID）");
            }
            if (patientRef.matches("^1\\d{10}$")) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "patientRef 只接受内部患者 ID，不接受姓名或手机号");
            }
            var patient = userRepository.findById(patientRef)
                    .orElseThrow(() -> new ApiException("PATIENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "患者不存在（patientRef 须为已登记的内部患者 ID）"));
            occupantUserId = patient.id();
            occupantDisplayName = maskName(patient.displayName());
            admittedAt = now;
        }

        boolean updated = bedRepository.updateAssignment(bedId, request.expectedVersion(),
                ACTION_TARGET.get(action), occupantUserId, occupantDisplayName, admittedAt, request.note(),
                idempotencyKey, digest, now);
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "版本不匹配（乐观锁），请刷新后重试", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail("expectedVersion",
                            "当前 version=" + bed.version() + "，请求 expectedVersion=" + request.expectedVersion(),
                            "VERSION_CONFLICT")));
        }
        return toData(bedRepository.findBed(bedId).orElseThrow());
    }

    /** 契约 Bed：occupantDisplayName 已在写入时脱敏，出参不再二次加工。 */
    private static BedData toData(BedRepository.BedRow b) {
        return new BedData(b.id(), b.wardId(), b.wardName(), b.label(), b.status(),
                b.occupantDisplayName(), b.admittedAt(), b.version());
    }

    /** 脱敏展示名：保留首字，其余以 * 代替（写入时即脱敏，床位表不落明文姓名）。 */
    static String maskName(String displayName) {
        if (displayName == null || displayName.isBlank()) {
            return null;
        }
        String name = displayName.trim();
        return name.charAt(0) + "*".repeat(Math.max(name.length() - 1, 0));
    }

    /** 载荷摘要：字段顺序固定，null 归一为空串（同键同体判定依据）。 */
    private static String canonical(BedAssignmentRequest r) {
        return String.join("|",
                nullToEmpty(r.action()),
                nullToEmpty(r.patientRef()),
                String.valueOf(r.expectedVersion()),
                nullToEmpty(r.note()));
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
