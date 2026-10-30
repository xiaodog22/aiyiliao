package com.wechar.biz.doctor;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.appointment.AppointmentService;
import com.wechar.biz.appointment.dto.AppointmentData;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.auth.SmsChallengeService;
import com.wechar.biz.auth.dto.SessionData;
import com.wechar.biz.auth.dto.WechatLoginRequest;
import com.wechar.biz.bed.BedRepository;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.common.Digests;
import com.wechar.biz.common.GlobalExceptionHandler;
import com.wechar.biz.doctor.dto.AppointmentStatusUpdateRequest;
import com.wechar.biz.doctor.dto.DoctorAccountLoginRequest;
import com.wechar.biz.doctor.dto.DoctorOverviewData;
import com.wechar.biz.doctor.dto.DoctorProfileData;
import com.wechar.biz.doctor.dto.DoctorTodoData;
import com.wechar.biz.doctor.dto.DoctorWorkbenchData;
import com.wechar.biz.message.MessageService;
import com.wechar.biz.user.UserRepository;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 医生端服务（契约 M3 doctor 域）：
 *  - doctorLogin：与患者登录同一套令牌机制，但**角色由服务端按任职关系判定**（doctors.user_id + ACTIVE）；
 *  - getDoctorWorkbench：数据范围按任职科室/病区裁剪，子块独立降级；
 *  - listDoctorAppointments：doctor_id 参与查询条件（不接受客户端传范围），支持 status/date/cursor/limit；
 *  - updateAppointmentStatus：状态机 + expectedVersion 乐观锁 + 事件落表，幂等键可重放。
 */
@Service
public class DoctorService {

    private static final Logger log = LoggerFactory.getLogger(DoctorService.class);

    private static final int MAX_LIMIT = 50;

    /** 医生流转 → 患者通知文案（只描述服务端已确认的状态事实，不含医疗建议）。 */
    private static final Map<String, String> STATUS_NOTICE = Map.of(
            "CONFIRMED", "已确认您的预约",
            "CHECKED_IN", "已叫号，请前往诊室就诊",
            "COMPLETED", "已完成本次就诊",
            "CANCELLED", "已取消该预约",
            "NO_SHOW", "已将该预约标记为爽约",
            "EXPIRED", "该预约已过期");

    private final AuthService authService;
    private final DoctorRepository doctorRepository;
    private final AppointmentRepository appointmentRepository;
    private final AppointmentService appointmentService;
    private final BedRepository bedRepository;
    private final SmsChallengeService smsChallengeService;
    private final MessageService messageService;
    private final UserRepository userRepository;
    private final Clock clock;

    public DoctorService(AuthService authService, DoctorRepository doctorRepository,
                         AppointmentRepository appointmentRepository, AppointmentService appointmentService,
                         BedRepository bedRepository, SmsChallengeService smsChallengeService,
                         MessageService messageService, UserRepository userRepository, Clock clock) {
        this.authService = authService;
        this.doctorRepository = doctorRepository;
        this.appointmentRepository = appointmentRepository;
        this.appointmentService = appointmentService;
        this.bedRepository = bedRepository;
        this.smsChallengeService = smsChallengeService;
        this.messageService = messageService;
        this.userRepository = userRepository;
        this.clock = clock;
    }

    /**
     * 契约 doctorLogin：先落身份（与患者登录同一 upsert），再按数据库任职关系判角色。
     * 无 ACTIVE 医生任职 → 403（契约声明 403）；请求体无角色字段，客户端无法提权。
     */
    @Transactional
    public SessionData login(WechatLoginRequest request) {
        String userId = authService.loginIdentity(request);
        if (doctorRepository.findActiveByUserId(userId).isEmpty()) {
            throw new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN,
                    "该账号未登记医生任职关系，无法登录医生端（医生身份需院方预先登记）");
        }
        return authService.issueFreshSession(userId);
    }

    /** 医生职责校验：无 ACTIVE 任职 → 403（workbench/appointments/beds 契约均声明 403）。 */
    @Transactional(readOnly = true)
    public DoctorRepository.DoctorRow requireDoctor(String userId) {
        return doctorRepository.findActiveByUserId(userId)
                .orElseThrow(() -> new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN,
                        "当前账号无医生任职关系，无权访问医生端功能"));
    }

    /**
     * V21 契约 getDoctorProfile（GET /api/v1/doctor/me）：医生自述资料。
     * 无 ACTIVE 任职 → 403（与 workbench 同一职责边界）；字段全部来自任职行，
     * employeeNo 未登记 → null（NON_NULL 省略，前端不渲染，不编造）。
     */
    @Transactional(readOnly = true)
    public DoctorProfileData profile(String userId) {
        DoctorRepository.DoctorProfileRow row = doctorRepository.findProfileByUserId(userId)
                .orElseThrow(() -> new ApiException("FORBIDDEN", HttpStatus.FORBIDDEN,
                        "当前账号无医生任职关系，无权访问医生端功能"));
        return new DoctorProfileData(row.userId(), row.name(), row.employeeNo(),
                row.departmentId(), row.departmentName(), row.title());
    }

    /**
     * 契约 doctorLoginByAccount（N8，2026-10-19）：工号/手机号 + 短信验证码登录。
     * 顺序与任务书一致：参数齐全(400) → 校验 challengeId+credential(401) → 定位账号(401)
     * → requireDoctor(403) → 一次性消费(401) → issueFreshSession(200)。
     *  - account 为 11 位手机号 → users.phone_hash 查询；否则按工号 doctors.employee_no（V11）查询；
     *  - 验证码手机号必须与账号绑定手机号一致（工号登录同样校验），否则 401——
     *    该分支与"账号不存在"共用同一 401 文案，不构成存在性 oracle；
     *  - 无医生任职 → 403（契约声明 403；与越权 404 不同：此处是能力边界而非对象访问）。
     */
    @Transactional
    public SessionData loginByAccount(DoctorAccountLoginRequest request) {
        if (request == null || isBlank(request.account())) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "缺少必需字段 account");
        }
        if (isBlank(request.credential())) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "缺少必需字段 credential");
        }
        if (isBlank(request.challengeId())) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "缺少必需字段 challengeId");
        }
        String account = request.account().trim();
        var challenge = smsChallengeService.verify(request.challengeId().trim(), request.credential().trim(),
                "DOCTOR_LOGIN");

        String userId = resolveAccountUser(account);
        var user = userId == null ? null : userRepository.findById(userId).orElse(null);
        if (user == null || user.phoneHash() == null
                || !user.phoneHash().equals(challenge.phoneHash())) {
            // 账号不存在 与 验证码手机号不匹配 同一文案/状态（防账号枚举）
            throw new ApiException("INVALID_CREDENTIAL", HttpStatus.UNAUTHORIZED,
                    SmsChallengeService.CREDENTIAL_REJECTED);
        }
        requireDoctor(userId);
        smsChallengeService.consume(challenge.challengeId());
        return authService.issueFreshSession(userId);
    }

    /** 账号 → 内部用户 ID：11 位手机号走 phone_hash，其余按工号 employee_no；查不到返回 null（401）。 */
    private String resolveAccountUser(String account) {
        if (account.matches("1[3-9]\\d{9}")) {
            return userRepository.findByPhoneHash(Digests.sha256Hex(account))
                    .map(UserRepository.UserRow::id).orElse(null);
        }
        return doctorRepository.findActiveUserIdByEmployeeNo(account).orElse(null);
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    /**
     * 契约 listDoctorTodos（N3，2026-10-19）：医生待处理事项。
     * 只返回**服务端可判定**的待办；不可判定的类别不返回（不伪造条目）。
     *  - CHECKIN_CONFIRM：今日已签到待医生确认的挂号（appointments.status='CHECKED_IN'，可计数）；
     *  - CONSULT_REPLY（V21）：名下 ACTIVE 问诊中末条消息来自患者的会话
     *    （consultations.doctor_id 归属 + consultation_messages 末条角色，可判定）；
     *  - REPORT_REVIEW：需报告与医生的归属关联（当前 schema 未建立），服务端不可判定 → 不返回。
     *
     * ⚠️ CONSULT_REPLY 的 route 为 null：医生端「在线问诊处理」页尚未落地（遗留清单第 8 页 #8），
     *    按契约 null=不可点击，不指向不存在的页面。
     */
    @Transactional(readOnly = true)
    public List<DoctorTodoData> todos(String userId) {
        return todosFor(requireDoctor(userId));
    }

    /** todos 的可判定实现（overview 复用，避免二次 requireDoctor；调用方须已完成职责校验）。 */
    private List<DoctorTodoData> todosFor(DoctorRepository.DoctorRow doctor) {
        List<DoctorTodoData> todos = new ArrayList<>();
        Instant dayFrom = clock.instant().truncatedTo(ChronoUnit.DAYS);
        Instant dayTo = dayFrom.plus(1, ChronoUnit.DAYS);

        int checkin = doctorRepository.countAppointmentsByStatusInWindow(
                doctor.id(), dayFrom, dayTo, "CHECKED_IN");
        if (checkin > 0) {
            todos.add(new DoctorTodoData(
                    "todo-checkin-" + doctor.id(),
                    "CHECKIN_CONFIRM",
                    "预约签到待确认",
                    "今日已签到患者等待叫号确认",
                    checkin,
                    "/pages/doctor/appointments/appointments?from=todo",
                    clock.instant()));
        }

        int consultReply = doctorRepository.countConsultationsAwaitingReply(doctor.id());
        if (consultReply > 0) {
            todos.add(new DoctorTodoData(
                    "todo-consult-reply-" + doctor.id(),
                    "CONSULT_REPLY",
                    "在线问诊待回复",
                    "患者咨询等待医生处理",
                    consultReply,
                    null,
                    clock.instant()));
        }
        return todos;
    }

    /**
     * 契约 getDoctorOverview（N18，2026-10-19）：统计骨架，替代全量拉取前端聚合。
     *  - waiting=今日 CHECKED_IN · done=今日 COMPLETED · todayTotal=今日总数（UTC 日窗口，同 workbench）；
     *  - pendingTodos=N3 可判定待办条数；
     *  - inProgress 恒 null：状态机无「接诊中」状态，服务端不可判定（红线：不用 0 冒充）；
     *  - 子块独立降级：任一计数失败该字段为 null（前端不渲染该卡），其余照常返回。
     */
    @Transactional(readOnly = true)
    public DoctorOverviewData overview(String userId) {
        DoctorRepository.DoctorRow doctor = requireDoctor(userId);
        Instant dayFrom = clock.instant().truncatedTo(ChronoUnit.DAYS);
        Instant dayTo = dayFrom.plus(1, ChronoUnit.DAYS);
        List<String> unavailable = new ArrayList<>();

        Integer waiting = degrade(unavailable, "waiting",
                () -> doctorRepository.countAppointmentsByStatusInWindow(
                        doctor.id(), dayFrom, dayTo, "CHECKED_IN"));
        Integer done = degrade(unavailable, "done",
                () -> doctorRepository.countAppointmentsByStatusInWindow(
                        doctor.id(), dayFrom, dayTo, "COMPLETED"));
        Integer todayTotal = degrade(unavailable, "todayTotal",
                () -> doctorRepository.countAppointmentsInWindow(doctor.id(), dayFrom, dayTo));
        Integer pendingTodos = degrade(unavailable, "pendingTodos",
                () -> todosFor(doctor).size());

        return new DoctorOverviewData(waiting, null, done, todayTotal, pendingTodos);
    }

    /** 契约 getDoctorWorkbench：范围 = 任职科室 + 该科室下 ACTIVE 病区；计数按 UTC 日窗口。 */
    @Transactional(readOnly = true)
    public DoctorWorkbenchData workbench(String userId) {
        DoctorRepository.DoctorRow doctor = requireDoctor(userId);
        List<String> wardIds = bedRepository.listAuthorizedWardIds(doctor.departmentId());
        Instant dayFrom = clock.instant().truncatedTo(ChronoUnit.DAYS);
        Instant dayTo = dayFrom.plus(1, ChronoUnit.DAYS);

        List<String> unavailable = new ArrayList<>();
        Integer todayAppointments = degrade(unavailable, "今日挂号",
                () -> doctorRepository.countAppointmentsInWindow(doctor.id(), dayFrom, dayTo));
        // 解释性口径（登记于任务回执，契约只给出计数名未给定义）：
        // waitingPatients = 今日已签到待就诊（CHECKED_IN）数；pendingReviews = 今日待医生确认（PENDING）数。
        Integer waitingPatients = degrade(unavailable, "候诊",
                () -> doctorRepository.countAppointmentsByStatusInWindow(doctor.id(), dayFrom, dayTo, "CHECKED_IN"));
        Integer pendingReviews = degrade(unavailable, "待处理",
                () -> doctorRepository.countAppointmentsByStatusInWindow(doctor.id(), dayFrom, dayTo, "PENDING"));
        Integer availableBeds = degrade(unavailable, "床位",
                () -> bedRepository.countAvailable(wardIds));

        List<DoctorWorkbenchData.Block> blocks = List.of(
                block("今日挂号", unavailable),
                block("候诊", unavailable),
                block("待处理", unavailable),
                block("床位", unavailable));

        return new DoctorWorkbenchData(
                new DoctorWorkbenchData.Summary(todayAppointments, waitingPatients, availableBeds, pendingReviews),
                new DoctorWorkbenchData.Scope(List.of(doctor.departmentId()), wardIds),
                blocks);
    }

    /** 契约 listDoctorAppointments：返回 (items, nextCursor)；meta.nextCursor 为 null 表示没有更多。 */
    @Transactional(readOnly = true)
    public AppointmentPage listAppointments(String userId, String status, String date, String cursor, int limit) {
        DoctorRepository.DoctorRow doctor = requireDoctor(userId);
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);

        Instant dayFrom = null;
        Instant dayTo = null;
        if (date != null && !date.isBlank()) {
            try {
                LocalDate day = LocalDate.parse(date.trim());
                dayFrom = day.atStartOfDay(ZoneOffset.UTC).toInstant();
                dayTo = dayFrom.plus(1, ChronoUnit.DAYS);
            } catch (DateTimeParseException e) {
                throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST, "date 需为 yyyy-MM-dd 格式");
            }
        }

        Instant cursorTime = null;
        String cursorId = null;
        if (cursor != null && !cursor.isBlank()) {
            Cursors.PageCursor decoded = Cursors.decode(cursor.trim());
            cursorTime = decoded.createdAt();
            cursorId = decoded.id();
        }

        List<AppointmentRepository.AppointmentView> rows = appointmentRepository.listViewByDoctor(
                doctor.id(), status, dayFrom, dayTo, cursorTime, cursorId, bounded + 1);
        boolean hasMore = rows.size() > bounded;
        List<AppointmentRepository.AppointmentView> page = hasMore ? rows.subList(0, bounded) : rows;
        List<AppointmentData> items = page.stream().map(v -> appointmentService.toData(v, null)).toList();
        String nextCursor = hasMore && !page.isEmpty()
                ? Cursors.encode(page.get(page.size() - 1).startTime(), page.get(page.size() - 1).appt().id())
                : null;
        return new AppointmentPage(items, nextCursor);
    }

    /** doctor 列表响应：items + nextCursor（nextCursor 透传到契约 ApiMeta）。 */
    public record AppointmentPage(List<AppointmentData> items, String nextCursor) {
    }

    /**
     * 契约 updateAppointmentStatus：
     *  1) 幂等：同键**同资源同载荷** → 返回当前资源（不重复流转）；同键异载荷（含跨预约复用）→ 409；
     *  2) 范围：仅本医生的挂号（他人/他科一律 404，不泄露存在性）；
     *  3) 状态机：非法转换（含终态、含流转到自身）→ 409；
     *  4) 乐观锁：expectedVersion 不匹配 → 409；
     *  5) 事件：每次真实流转写 appointment_status_events（操作者/时间/服务端时间戳）。
     */
    /**
     * 状态流转结果：appointment + 是否幂等重放（replayed 供控制器回 {@code Idempotency-Replayed} 头，
     * 与 care-plan / 预约创建 / 问诊创建三个端点的既有行为保持一致 —— 2026-10-18 D1 统一）。
     */
    public record StatusTransition(AppointmentData appointment, boolean replayed) {}

    @Transactional
    public StatusTransition updateStatus(String userId, String appointmentId, String idempotencyKey,
                                         AppointmentStatusUpdateRequest request) {
        DoctorRepository.DoctorRow doctor = requireDoctor(userId);
        String digest = Digests.sha256Hex(canonical(appointmentId, request));

        var recorded = appointmentRepository.findStatusEvent(userId, idempotencyKey);
        if (recorded.isPresent()) {
            if (!digest.equals(recorded.get().requestDigest())) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键", false,
                        List.of(new GlobalExceptionHandler.ErrorDetail(
                                "Idempotency-Key", "同键不同载荷，按契约返回 409", "IDEMPOTENCY_KEY_REUSE")));
            }
            var replayed = appointmentRepository.findViewById(recorded.get().appointmentId())
                    .filter(v -> doctor.id().equals(v.appt().doctorId()))
                    .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "预约不存在"));
            return new StatusTransition(appointmentService.toData(replayed, null), true);
        }

        var view = appointmentRepository.findViewById(appointmentId)
                .filter(v -> doctor.id().equals(v.appt().doctorId()))
                .orElseThrow(() -> new ApiException("APPOINTMENT_NOT_FOUND", HttpStatus.NOT_FOUND, "预约不存在"));
        var row = view.appt();

        AppointmentStatusMachine.requireTransition(row.status(), request.toStatus());

        Instant now = clock.instant();
        if (!appointmentRepository.updateStatusWithVersion(appointmentId, request.expectedVersion(),
                request.toStatus(), now)) {
            throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                    "版本不匹配（乐观锁），请刷新后重试", false,
                    List.of(new GlobalExceptionHandler.ErrorDetail("expectedVersion",
                            "当前 version=" + row.version() + "，请求 expectedVersion=" + request.expectedVersion(),
                            "VERSION_CONFLICT")));
        }

        appointmentRepository.insertStatusEvent(new AppointmentRepository.StatusEventRow(
                        "ase-" + UUID.randomUUID(), appointmentId, row.status(), request.toStatus(), userId,
                        doctor.id(), request.note(), row.version() + 1, now, digest),
                idempotencyKey, digest);

        var updated = appointmentRepository.findViewById(appointmentId).orElseThrow();
        // V21 互通闭环：医生流转成功 → 通知患者（消息中心 + 未读红点；同一事务，失败整体回滚）
        String notice = STATUS_NOTICE.get(request.toStatus());
        if (notice != null) {
            messageService.notify(row.userId(), MessageService.TYPE_APPOINTMENT_STATUS,
                    "预约状态更新", notice + "（" + updated.doctorName() + " 医生）",
                    "appointment", appointmentId);
        }
        return new StatusTransition(appointmentService.toData(updated, null), false);
    }

    /**
     * 载荷摘要：字段顺序固定，null 归一为空串（同键同体判定依据）。
     *
     * ⚠️ appointmentId 必须参与摘要（2026-10-18 修正）：
     * 幂等键的作用域是 (operator_user_id, idempotency_key)，**键本身不绑定资源**。
     * 此前摘要只含 toStatus|expectedVersion|note，于是同一个键被用到另一条预约上、
     * 且状态/版本/备注恰好相同时，摘要一致 → 命中重放分支，**返回上一条预约的数据并 200**，
     * 而目标预约被静默忽略（既不流转也不报错）。把 appointmentId 纳入摘要后，
     * 这种"同键跨预约"会正确落到 409 IDEMPOTENCY_KEY_REUSE。
     * 影响：升级前写入的旧事件重放时会因摘要变化返回 409（键为单次请求生成，影响可忽略）。
     */
    private static String canonical(String appointmentId, AppointmentStatusUpdateRequest r) {
        return String.join("|",
                nullToEmpty(appointmentId),
                nullToEmpty(r.toStatus()),
                String.valueOf(r.expectedVersion()),
                nullToEmpty(r.note()));
    }

    private static String nullToEmpty(String s) {
        return s == null ? "" : s;
    }

    /** 子块独立降级：成功回计数；失败把块名记入 unavailable 并返回 null（不用 0 冒充真实值）。 */
    private static Integer degrade(List<String> unavailable, String blockName,
                                   java.util.function.Supplier<Integer> supplier) {
        try {
            return supplier.get();
        } catch (RuntimeException e) {
            log.warn("工作台子块降级 block={}", blockName, e);
            unavailable.add(blockName);
            return null;
        }
    }

    private static DoctorWorkbenchData.Block block(String name, List<String> unavailable) {
        return new DoctorWorkbenchData.Block(name,
                unavailable.contains(name) ? DoctorWorkbenchData.Block.UNAVAILABLE : DoctorWorkbenchData.Block.OK);
    }
}
