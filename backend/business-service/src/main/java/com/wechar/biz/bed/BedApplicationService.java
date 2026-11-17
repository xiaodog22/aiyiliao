package com.wechar.biz.bed;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.bed.dto.BedApplicationData;
import com.wechar.biz.bed.dto.BedApplicationRequest;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.doctor.DoctorRepository;
import com.wechar.biz.doctor.DoctorService;
import com.wechar.biz.user.UserRepository;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 床位申请服务（申请制，2026-11-15）。
 *
 * 职责边界：
 *  · 医生端只能**提交申请**与**查看自己的申请**，不再直接改床位状态；
 *  · 审批（APPROVED / REJECTED）由病区护士站/住院处执行，本机演示走 dev 管理端点；
 *  · 审批通过且申请指定了床位时，在同一事务内落床（beds.status → OCCUPIED）——
 *    床位已被别人抢走则整笔回滚并返回 409，申请保持 PENDING，不出现「批了但没床」。
 *
 * 与 BedService 的分工：BedService 负责床位状态机本身（含 ASSIGN/RELEASE 等动作，
 * 保留给护士站），本服务只决定「谁可以申请、申请单如何流转」。
 */
@Service
public class BedApplicationService {

    /** 可审批的结论：只有通过/驳回两种，不做「部分通过」。 */
    private static final Set<String> DECISIONS = Set.of("APPROVED", "REJECTED");

    private static final int LIST_LIMIT = 50;

    private final BedApplicationRepository applicationRepository;
    private final BedRepository bedRepository;
    private final AppointmentRepository appointmentRepository;
    private final DoctorService doctorService;
    private final UserRepository userRepository;
    private final Clock clock;

    public BedApplicationService(BedApplicationRepository applicationRepository,
                                 BedRepository bedRepository,
                                 AppointmentRepository appointmentRepository,
                                 DoctorService doctorService,
                                 UserRepository userRepository,
                                 Clock clock) {
        this.applicationRepository = applicationRepository;
        this.bedRepository = bedRepository;
        this.appointmentRepository = appointmentRepository;
        this.doctorService = doctorService;
        this.userRepository = userRepository;
        this.clock = clock;
    }

    /** 提交申请：幂等键 + 病区/床位归属校验 + 患者存在性校验（不接受姓名/手机号）。 */
    @Transactional
    public BedApplicationData submit(String userId, String idempotencyKey, BedApplicationRequest request) {
        DoctorRepository.DoctorRow doctor = doctorService.requireDoctor(userId);

        String patientRef = blankToNull(request.patientRef());
        String appointmentId = blankToNull(request.appointmentId());
        if (patientRef != null && appointmentId != null) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "appointmentId 与 patientRef 只能二选一，避免患者身份歧义");
        }
        if (appointmentId != null) {
            AppointmentRepository.AppointmentRow appt = appointmentRepository.findById(appointmentId)
                    .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "预约不存在或不属于当前医生"));
            if (!doctor.id().equals(appt.doctorId())) {
                throw new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "预约不存在或不属于当前医生");
            }
            if (blankToNull(appt.familyMemberId()) != null) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "该预约是家属代约，请改用手动患者编号（实际就诊患者）");
            }
            String apptStatus = String.valueOf(appt.status()).trim().toUpperCase();
            if (Set.of("CANCELLED", "EXPIRED", "NO_SHOW").contains(apptStatus)) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "该预约已取消/过期/未到诊，不能申请床位");
            }
            patientRef = blankToNull(appt.userId());
            if (patientRef == null) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "预约缺少患者身份，请改用手动患者编号");
            }
        } else {
            if (patientRef == null) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "请选择患者，或填写内部患者 ID（patientRef）");
            }
            if (patientRef.matches("^1\\d{10}$")) {
                throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                        "patientRef 只接受内部患者 ID，不接受姓名或手机号");
            }
        }
        UserRepository.UserRow patient = userRepository.findById(patientRef)
                .orElseThrow(() -> new ApiException("PATIENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "患者不存在（patientRef 须为已登记的内部患者 ID）"));

        String bedId = blankToNull(request.bedId());
        String wardId = blankToNull(request.wardId());
        if (bedId != null) {
            BedRepository.BedRow bed = bedRepository.findBed(bedId)
                    .filter(b -> doctor.departmentId().equals(
                            bedRepository.findBedDepartmentId(b.id()).orElse(null)))
                    .orElseThrow(() -> new ApiException("BED_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "床位不存在或不属于当前医生的授权病区"));
            if (!"AVAILABLE".equals(bed.status())) {
                throw new ApiException("BED_STATE_CONFLICT", HttpStatus.CONFLICT,
                        "该床位当前不可申请（状态 " + bed.status() + "）", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "bedId", "床位状态 " + bed.status() + " 不可申请", "BED_STATE_CONFLICT")));
            }
            // 只给床位不给病区时按床位所属病区补齐，避免申请单缺少病区信息
            if (wardId == null) {
                wardId = bed.wardId();
            }
        }
        if (wardId != null) {
            List<String> authorized = bedRepository.listAuthorizedWardIds(doctor.departmentId());
            if (!authorized.contains(wardId)) {
                throw new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN, "该病区不在当前医生的授权范围内");
            }
        }

        String reason = request.reason() == null ? null : request.reason().trim();
        String priority = request.normalizedPriority();
        String digest = Digests.sha256Hex(String.join("|",
                patientRef, nullToEmpty(bedId), nullToEmpty(wardId), nullToEmpty(reason), priority));

        // 幂等：同键同载荷 → 返回已存在的申请；同键异载荷 → 409（与床位分配同一口径）
        var existing = applicationRepository.findByIdempotencyKey(idempotencyKey);
        if (existing.isPresent()) {
            BedApplicationRepository.ApplicationRow row = existing.get();
            if (digest.equals(row.requestDigest())) {
                return toData(row);
            }
            throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                    "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
        }

        Instant now = clock.instant();
        String id = "ba-" + UUID.randomUUID();
        applicationRepository.insert(id, doctor.id(), doctor.departmentId(), wardId, bedId,
                patientRef, BedService.maskName(patient.displayName()), reason, priority, "PENDING",
                idempotencyKey, digest, now);
        return toData(applicationRepository.findById(id).orElseThrow());
    }

    /** 医生自己的申请列表（默认全部状态，倒序）。 */
    @Transactional(readOnly = true)
    public List<BedApplicationData> listMine(String userId, String status) {
        DoctorRepository.DoctorRow doctor = doctorService.requireDoctor(userId);
        return applicationRepository.listByDoctor(doctor.id(), status, LIST_LIMIT)
                .stream().map(BedApplicationService::toData).toList();
    }

    /** 护士站待办（dev 管理端点）：全院按状态列出申请单。 */
    @Transactional(readOnly = true)
    public List<BedApplicationData> listForReview(String status) {
        return applicationRepository.listByStatus(status, LIST_LIMIT)
                .stream().map(BedApplicationService::toData).toList();
    }

    /**
     * 审批：PENDING → APPROVED / REJECTED。
     * APPROVED 且申请带 bedId 时先落床；床位已被占用 → 409，整笔回滚，申请保持 PENDING。
     */
    @Transactional
    public BedApplicationData review(String applicationId, String decision, String note, String reviewer) {
        String d = decision == null ? "" : decision.trim().toUpperCase();
        if (!DECISIONS.contains(d)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "decision 只能是 APPROVED 或 REJECTED");
        }
        BedApplicationRepository.ApplicationRow app = applicationRepository.findById(applicationId)
                .orElseThrow(() -> new ApiException("APPLICATION_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "床位申请不存在"));
        if (!"PENDING".equals(app.status())) {
            throw new ApiException("APPLICATION_STATE_CONFLICT", HttpStatus.CONFLICT,
                    "该申请已处理（当前状态 " + app.status() + "），不能重复审批", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail(
                            "status", "申请状态 " + app.status() + " 不允许审批", "APPLICATION_STATE_CONFLICT")));
        }

        Instant now = clock.instant();
        if ("APPROVED".equals(d) && app.bedId() != null && !app.bedId().isBlank()) {
            BedRepository.BedRow bed = bedRepository.findBed(app.bedId())
                    .orElseThrow(() -> new ApiException("BED_NOT_FOUND", HttpStatus.NOT_FOUND,
                            "申请指定的床位已不存在"));
            if (!"AVAILABLE".equals(bed.status())) {
                throw new ApiException("BED_STATE_CONFLICT", HttpStatus.CONFLICT,
                        "床位已被占用（当前状态 " + bed.status() + "），请改派其他床位后重新审批", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "bedId", "床位状态 " + bed.status() + "，无法落床", "BED_STATE_CONFLICT")));
            }
            String digest = Digests.sha256Hex("BED_APPROVE|" + app.id());
            boolean occupied = bedRepository.updateAssignment(app.bedId(), bed.version(), "OCCUPIED",
                    app.patientRef(), app.patientDisplayName(), now, note, "bed-app-" + app.id(), digest, now);
            if (!occupied) {
                throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                        "床位状态已变化，请刷新后重新审批", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail("bedId",
                                "当前 version=" + bed.version(), "VERSION_CONFLICT")));
            }
        }

        if (!applicationRepository.review(app.id(), d, note, reviewer, now)) {
            throw new ApiException("APPLICATION_STATE_CONFLICT", HttpStatus.CONFLICT,
                    "该申请已被其他人处理，请刷新");
        }
        return toData(applicationRepository.findById(app.id()).orElseThrow());
    }

    public int countPending(String userId) {
        DoctorRepository.DoctorRow doctor = doctorService.requireDoctor(userId);
        return applicationRepository.countPendingByDoctor(doctor.id());
    }

    private static BedApplicationData toData(BedApplicationRepository.ApplicationRow a) {
        return new BedApplicationData(a.id(), a.doctorId(), a.doctorName(), a.departmentId(),
                a.wardId(), a.wardName(), a.bedId(), a.bedLabel(), a.patientDisplayName(), a.reason(),
                a.priority(), a.status(), a.reviewNote(), a.reviewedAt(), a.createdAt());
    }

    private static String blankToNull(String s) {
        if (s == null) {
            return null;
        }
        String t = s.trim();
        return t.isEmpty() ? null : t;
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
