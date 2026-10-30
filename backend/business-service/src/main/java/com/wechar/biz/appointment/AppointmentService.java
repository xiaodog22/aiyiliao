package com.wechar.biz.appointment;

import com.wechar.biz.appointment.dto.AppointmentCreateRequest;
import com.wechar.biz.appointment.dto.AppointmentData;
import com.wechar.biz.appointment.dto.AppointmentStatsData;
import com.wechar.biz.appointment.dto.AppointmentUpdateRequest;
import com.wechar.biz.appointment.dto.CreateResult;
import com.wechar.biz.catalog.CatalogRepository;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.crypto.PhoneCrypto;
import com.wechar.biz.message.MessageService;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.List;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 预约服务（M1.4 / 任务书规则 4-6）：
 *  - 幂等：Idempotency-Key 必填；同键同载荷 → 200 + 原资源 + Idempotency-Replayed: true；
 *    同键异载荷 → 409 IDEMPOTENCY_KEY_REUSE；缺键 → 400。
 *  - 号源：原子扣减（UPDATE remaining-1 WHERE remaining>0），0 行 → 409 SLOT_FULL。
 *  - 过去时段 → 422 SLOT_IN_PAST；slot 与 doctor 关联校验；事务包裹；status=PENDING。
 *  - PATCH：version 必填，不匹配 → 409 VERSION_CONFLICT；终态（CANCELLED/COMPLETED/…）不可改 → 409。
 */
@Service
public class AppointmentService {

    /** 消息体时间展示（Asia/Shanghai，与 home 问候同一时区口径）。 */
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter DAY_TIME = DateTimeFormatter.ofPattern("M月d日HH:mm");

    private final AppointmentRepository repository;
    private final CatalogRepository catalog;
    private final PhoneCrypto phoneCrypto;
    private final MessageService messageService;
    private final Clock clock;

    public AppointmentService(AppointmentRepository repository, CatalogRepository catalog,
                              PhoneCrypto phoneCrypto, MessageService messageService, Clock clock) {
        this.repository = repository;
        this.catalog = catalog;
        this.phoneCrypto = phoneCrypto;
        this.messageService = messageService;
        this.clock = clock;
    }

    /** 创建预约（幂等键由控制器校验后传入）。 */
    @Transactional
    public CreateResult create(String userId, String idempotencyKey, AppointmentCreateRequest request) {
        String digest = Digests.sha256Hex(canonical(request));

        // (a) 幂等：同键先查
        var existing = repository.findByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            var row = existing.get();
            if (!row.requestDigest().equals(digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                        List.of(new com.wechar.biz.common.GlobalExceptionHandler.ErrorDetail(
                                "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
            }
            return new CreateResult(toData(repository.findViewById(row.id()).orElseThrow(), Boolean.TRUE), true);
        }

        // (b) 号源
        var slot = repository.findSlot(request.slotId())
                .orElseThrow(() -> new ApiException("SLOT_NOT_FOUND", HttpStatus.NOT_FOUND, "号源不存在"));

        // (c) 过去时段 → 422 SLOT_IN_PAST
        Instant now = clock.instant();
        if (slot.startTime() == null || !slot.startTime().isAfter(now)) {
            throw new ApiException("SLOT_IN_PAST", HttpStatus.UNPROCESSABLE_ENTITY,
                    "该时段已过，请选择未来号源", false,
                    List.of(new com.wechar.biz.common.GlobalExceptionHandler.ErrorDetail(
                            "slotId", "号源开始时间早于当前时间", "SLOT_IN_PAST")));
        }
        if (!"OPEN".equals(slot.status())) {
            throw new ApiException("SLOT_CLOSED", HttpStatus.CONFLICT, "该号源已关闭");
        }

        // (d) doctor 属于 slot 的科室关联校验（slot.doctorId → doctors.department_id）
        var doctor = catalog.findDoctor(slot.doctorId())
                .orElseThrow(() -> new ApiException("DOCTOR_NOT_FOUND", HttpStatus.NOT_FOUND, "医生不存在"));
        // 就诊地点快照：下单时冗余自科室，科室搬迁不影响历史记录（V7 location/hospital_name）
        var department = catalog.findDepartment(doctor.departmentId()).orElse(null);
        String location = department == null ? null : department.location();
        String hospitalName = department == null ? null : department.hospitalName();

        // (b) 原子扣减：0 行 → SLOT_FULL
        if (!repository.decrementSlotRemaining(request.slotId())) {
            throw new ApiException("SLOT_FULL", HttpStatus.CONFLICT,
                    "该号源已满，请重新选择号源", false,
                    List.of(new com.wechar.biz.common.GlobalExceptionHandler.ErrorDetail(
                            "slotId", "剩余号源为 0，原子扣减失败", "SLOT_FULL")));
        }

        byte[] phoneCipher = null;
        if (request.contactPhone() != null && !request.contactPhone().isBlank()) {
            if (!PhoneCrypto.isValidPhone(request.contactPhone())) {
                throw new ApiException("PHONE_INVALID", HttpStatus.UNPROCESSABLE_ENTITY, "手机号格式不正确（须为 11 位）");
            }
            phoneCipher = phoneCrypto.encrypt(request.contactPhone()).getBytes(StandardCharsets.UTF_8);
        }

        String id = "ap-" + UUID.randomUUID();
        repository.insertAppointment(new AppointmentRepository.AppointmentRow(
                id, userId, request.familyMemberId(), request.slotId(), slot.doctorId(), doctor.departmentId(),
                request.patientName(), phoneCipher, request.symptomSummary(), "PENDING",
                null, null, idempotencyKey, digest, 1, now, null), location, hospitalName);

        var view = repository.findViewById(id)
                .orElseThrow(() -> new ApiException("INTERNAL_ERROR", HttpStatus.INTERNAL_SERVER_ERROR,
                        "预约写入后读取失败", true, null));
        // V21 互通：挂号成功即时通知患者（消息中心 + 未读红点数据源；与下单同一事务）
        messageService.notify(userId, MessageService.TYPE_APPOINTMENT_CREATED, "挂号成功",
                buildCreatedBody(view), "appointment", id);
        return new CreateResult(toData(view, Boolean.FALSE), false);
    }

    /** 挂号成功消息体：只描述服务端已确认的事实（医生/科室/时间），不含任何医疗建议。 */
    private static String buildCreatedBody(AppointmentRepository.AppointmentView view) {
        String when = view.startTime() == null ? "所选时段"
                : DAY_TIME.format(view.startTime().atZone(ZONE));
        return String.format("您已预约 %s 医生（%s）%s 的就诊号，请提前 15 分钟到院取号。",
                view.doctorName(), view.departmentName(), when);
    }

    /**
     * 并发同键撞 uk_appointments_idem 后的重放读取（无事务，仅供控制器在
     * DataIntegrityViolationException 兜底路径调用）：
     *  同键同体 → 幂等重放（replayed=true）；同键异体 → 409；键尚不可见（死锁全员回滚）→ null。
     */
    public CreateResult replaySameKey(String userId, String idempotencyKey, AppointmentCreateRequest request) {
        var existing = repository.findByIdempotencyKey(userId, idempotencyKey);
        if (existing.isEmpty()) {
            return null;
        }
        var row = existing.get();
        String digest = Digests.sha256Hex(canonical(request));
        if (!row.requestDigest().equals(digest)) {
            throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                    "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                    List.of(new com.wechar.biz.common.GlobalExceptionHandler.ErrorDetail(
                            "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
        }
        return new CreateResult(toData(repository.findViewById(row.id()).orElseThrow(), Boolean.TRUE), true);
    }

    /**
     * PATCH 更新（version 乐观锁 + 状态机）。
     * 仅 PENDING/CONFIRMED 可变更字段；CANCELLED/COMPLETED/… 终态 → 409。
     */
    @Transactional
    public AppointmentData patch(String appointmentId, AppointmentUpdateRequest request) {
        if (request.version() == null) {
            throw new ApiException("VERSION_REQUIRED", HttpStatus.BAD_REQUEST, "缺少必需字段 version（乐观锁）");
        }
        var view = repository.findViewById(appointmentId)
                .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "预约不存在"));
        var row = view.appt();
        String status = row.status();
        if ("CANCELLED".equals(status) || "COMPLETED".equals(status) || "EXPIRED".equals(status)
                || "NO_SHOW".equals(status)) {
            throw new ApiException("APPOINTMENT_STATE_FINAL", HttpStatus.CONFLICT,
                    "预约已处于终态（" + status + "），不可再修改");
        }
        if (!"PENDING".equals(status) && !"CONFIRMED".equals(status)) {
            throw new ApiException("APPOINTMENT_STATE_CONFLICT", HttpStatus.CONFLICT,
                    "当前状态（" + status + "）不允许修改");
        }

        byte[] phoneCipher = row.contactPhoneCipher();
        if (request.contactPhone() != null && !request.contactPhone().isBlank()) {
            if (!PhoneCrypto.isValidPhone(request.contactPhone())) {
                throw new ApiException("PHONE_INVALID", HttpStatus.UNPROCESSABLE_ENTITY, "手机号格式不正确（须为 11 位）");
            }
            phoneCipher = phoneCrypto.encrypt(request.contactPhone()).getBytes(StandardCharsets.UTF_8);
        }

        boolean updated = repository.updateWithVersion(appointmentId, request.version(),
                request.symptomSummary() != null ? request.symptomSummary() : row.symptomSummary(),
                request.familyMemberId() != null ? request.familyMemberId() : row.familyMemberId(),
                phoneCipher, row.status(), row.cancelReason(), clock.instant());
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "版本不匹配（乐观锁），请刷新后重试", false,
                    List.of(new com.wechar.biz.common.GlobalExceptionHandler.ErrorDetail(
                            "version", "当前 version=" + row.version() + "，请求 version=" + request.version(),
                            "VERSION_CONFLICT")));
        }
        return toData(repository.findViewById(appointmentId).orElseThrow(), null);
    }

    /** 我的预约列表（服务端身份范围过滤：user_id 在查询条件内）。 */
    @Transactional(readOnly = true)
    public List<AppointmentData> list(String userId, String status, int limit) {
        return repository.listViewByUser(userId, status, limit).stream()
                .map(v -> toData(v, null)).toList();
    }

    /**
     * 契约 GET /by-idempotency-key/{key}：仅当前用户（user_id 参与查询条件）；
     * 无记录（含他人记录，不泄露存在性）→ 404 APPOINTMENT_NOT_FOUND。
     */
    @Transactional(readOnly = true)
    public AppointmentData findByIdempotencyKey(String userId, String key) {
        var view = repository.findViewByIdempotencyKey(userId, key)
                .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "该幂等键下不存在当前用户的预约记录"));
        return toData(view, null);
    }

    /**
     * 契约 POST /{appointmentId}/cancel：
     *  - 范围过滤：仅当前用户（他人预约 → 404，不泄露存在性）；
     *  - 状态机：PENDING/CONFIRMED/CHECKED_IN → 置 CANCELLED（乐观锁 version+1）；
     *  - 重复取消已 CANCELLED → 200 返回同一终态（不报错）；
     *  - 其他终态（COMPLETED/EXPIRED/NO_SHOW）→ 409（不允许取消的状态）；
     *  - Idempotency-Key 由控制器校验必填与长度；取消结果确定（同一资源），
     *    重复调用天然幂等 —— 同终态回放即幂等语义。
     */
    @Transactional
    public AppointmentData cancel(String userId, String appointmentId, String idempotencyKey, String reason) {
        var view = repository.findViewById(appointmentId)
                .filter(v -> userId.equals(v.appt().userId())) // 身份范围过滤（不泄露他人存在性）
                .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "预约不存在"));
        var row = view.appt();
        String status = row.status();

        if ("CANCELLED".equals(status)) {
            return toData(view, null); // 重复取消 → 同一终态 200
        }
        if (!"PENDING".equals(status) && !"CONFIRMED".equals(status) && !"CHECKED_IN".equals(status)) {
            throw new ApiException("APPOINTMENT_STATE_CONFLICT", HttpStatus.CONFLICT,
                    "当前状态（" + status + "）不允许取消");
        }
        String cancelReason = reason != null && reason.length() <= 200 ? reason : row.cancelReason();
        boolean updated = repository.updateWithVersion(appointmentId, row.version(),
                row.symptomSummary(), row.familyMemberId(), row.contactPhoneCipher(),
                "CANCELLED", cancelReason, clock.instant());
        if (!updated) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "预约刚被其他请求修改，请重试");
        }
        // V21 互通闭环：取消成功 → 号源原子回补（仅 slot 仍 OPEN 且未满时生效；
        // 过期/关闭的号源本就不可再约，不回补）。同一事务，失败整体回滚。
        repository.releaseSlotRemaining(row.slotId());
        return toData(repository.findViewById(appointmentId).orElseThrow(), null);
    }

    /** stats：upcoming/completed/cancelled。 */
    @Transactional(readOnly = true)
    public AppointmentStatsData stats(String userId) {
        AppointmentRepository.Stats s = repository.statsForUser(userId, clock.instant());
        return new AppointmentStatsData(s.upcoming(), s.completed(), s.cancelled());
    }

    /**
     * 视图 → 契约 Appointment 数据（医生端 M3 列表/流转共用同一映射，避免两处口径漂移）。
     * replayed：仅创建接口返回（true/false 均显式给出）；列表/流转返回 null（契约可选字段，NON_NULL 省略）。
     *
     * V21 互通字段：
     *  - doctorTitle：医生职称（ doctors.title，医生端接诊列表与患者端记录展示）；
     *  - patientPhoneMasked：患者联系手机号脱敏值（服务端解密后掩码；明文永不出服务端；
     *    未留联系方式 / 解密失败 → null，前端不渲染该行）；
     *  - patientAvatarUrl：患者头像相对路径（users.avatar_key 原样透传，匿名端点可读；
     *    无头像 → null，客户端用内置默认头像）。
     */
    public AppointmentData toData(AppointmentRepository.AppointmentView view, Boolean replayed) {
        var a = view.appt();
        return new AppointmentData(a.id(), a.status(), a.slotId(), a.doctorId(), view.doctorName(),
                view.doctorTitle(), a.departmentId(), view.departmentName(), a.patientName(),
                maskedContactPhone(a.contactPhoneCipher()), normalizeAvatarUrl(view.patientAvatarKey()),
                view.startTime(), view.endTime(),
                a.queueNumber(), view.location(), view.hospitalName(), a.symptomSummary(), a.version(),
                replayed, a.createdAt(), a.updatedAt());
    }

    /** 联系手机号脱敏（138****1234）；密文缺失/密钥轮换解密失败 → null（不猜、不渲染）。 */
    private String maskedContactPhone(byte[] cipher) {
        if (cipher == null || cipher.length == 0) {
            return null;
        }
        try {
            String plain = phoneCrypto.decrypt(new String(cipher, StandardCharsets.UTF_8));
            return plain != null && plain.length() == 11
                    ? plain.substring(0, 3) + "****" + plain.substring(7) : null;
        } catch (RuntimeException e) {
            return null;
        }
    }

    /** 头像归一：空串按 null 处理（契约 [string,'null']）；相对路径/完整 URL 原样透传。 */
    private static String normalizeAvatarUrl(String avatarKey) {
        return avatarKey == null || avatarKey.isBlank() ? null : avatarKey;
    }

    /** 载荷摘要：字段顺序固定，null 归一为空串（同键同体判定依据）。 */
    private static String canonical(AppointmentCreateRequest r) {
        return String.join("|",
                nullToEmpty(r.slotId()), nullToEmpty(r.familyMemberId()), nullToEmpty(r.patientName()),
                nullToEmpty(r.contactPhone()), nullToEmpty(r.symptomSummary()));
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }
}
