package com.wechar.biz.doctor;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.doctor.dto.DoctorAvailabilityData;
import com.wechar.biz.doctor.dto.DoctorOnlineStatusData;
import com.wechar.biz.doctor.dto.DoctorScheduleData;
import com.wechar.biz.doctor.dto.DoctorScheduleUpdateRequest;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 排班与在线接诊（V22，2026-10-22）：把「医生工作台 → 排班设置」与「患者侧在线可用性」
 * 从占位变成真实能力。
 *
 * 设计要点：
 *  - 周模板是**整体替换**语义（PUT 以请求为准，缺失的天/时段即删除），version 为医生级乐观锁；
 *  - 幂等重放：客户端超时重试时 current == expected+1 且内容一致 → 200（不再 409），
 *    避免"其实已经保存成功、重试却报冲突"；
 *  - 在线状态是单行 upsert：online=true → accepting=true；online=false → 两者同时置 0；
 *    下线前若仍有待回复问诊 → 409 ONLINE_BUSY（不让患者对着"离线医生"干等）；
 *  - 患者侧 availability 只读，排班为空或没有未来时段 → nextSlotAt=null（不编造时间）。
 */
@Service
public class DoctorScheduleService {

    /** 号源粒度白名单（与号源生成口径一致；库层只保证 >0）。 */
    private static final Set<Integer> ALLOWED_SLOT_MINUTES = Set.of(10, 15, 20, 30, 60);
    private static final int MAX_SLOTS_PER_DAY = 8;

    private final DoctorScheduleRepository repository;
    private final DoctorService doctorService;
    private final DoctorRepository doctorRepository;
    private final Clock clock;

    public DoctorScheduleService(DoctorScheduleRepository repository, DoctorService doctorService,
                                 DoctorRepository doctorRepository, Clock clock) {
        this.repository = repository;
        this.doctorService = doctorService;
        this.doctorRepository = doctorRepository;
        this.clock = clock;
    }

    // ---------------------------------------------------------------- 读

    /** 医生本人周模板 + 在线状态（无排班 → version=0、weekdays 空数组）。 */
    @Transactional(readOnly = true)
    public DoctorScheduleData schedule(String userId) {
        return view(doctorService.requireDoctor(userId));
    }

    /** 患者侧只读：该医生当前是否在线接诊、下一次出诊开始时间。 */
    @Transactional(readOnly = true)
    public DoctorAvailabilityData availability(String doctorId) {
        if (doctorId == null || doctorId.isBlank()) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, "doctorId 不能为空");
        }
        var online = repository.findOnline(doctorId)
                .orElse(new DoctorScheduleRepository.OnlineRow(doctorId, false, false, 0, null));
        return new DoctorAvailabilityData(doctorId, online.online(), online.accepting(),
                nextSlotAt(doctorId));
    }

    // ---------------------------------------------------------------- 写

    /** 替换结果：replayed 用于 `Idempotency-Replayed` 响应头（与既有写接口同口径）。 */
    public record ScheduleReplaced(DoctorScheduleData schedule, boolean replayed) {
    }

    /** 整体替换周模板（乐观锁 + 幂等重放，见类注释）。 */
    @Transactional
    public ScheduleReplaced replaceSchedule(String userId, DoctorScheduleUpdateRequest request) {
        var doctor = doctorService.requireDoctor(userId);
        List<DoctorScheduleRepository.ScheduleRow> normalized = normalize(request);

        int current = repository.currentVersion(doctor.id());
        int expected = request.expectedVersion() == null ? 0 : request.expectedVersion();
        boolean replayed = false;
        if (current != expected) {
            // 幂等重放：上次已保存成功（版本已 +1）且内容与库里完全一致 → 按成功回放
            if (current == expected + 1 && sameAsStored(doctor.id(), normalized)) {
                replayed = true;
            } else {
                throw new ApiException("VERSION_CONFLICT", HttpStatus.CONFLICT,
                        "排班已被修改（当前版本 " + current + "，请求基于 " + expected + "），请刷新后重试");
            }
        }
        if (!replayed) {
            repository.replaceAll(doctor.id(), current + 1, normalized);
        }
        return new ScheduleReplaced(view(doctor), replayed);
    }

    /** 开关在线接诊：下线前校验是否仍有待回复问诊。 */
    @Transactional
    public DoctorOnlineStatusData setOnline(String userId, boolean online) {
        var doctor = doctorService.requireDoctor(userId);
        if (!online) {
            int pending = doctorRepository.countConsultationsAwaitingReply(doctor.id());
            if (pending > 0) {
                throw new ApiException("ONLINE_BUSY", HttpStatus.CONFLICT,
                        "还有 " + pending + " 条在线问诊待回复，请先处理完再下线");
            }
        }
        repository.upsertOnline(doctor.id(), online, online);
        var row = repository.findOnline(doctor.id())
                .orElseThrow(() -> new ApiException("SCHEDULE_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                        "在线状态保存失败，请稍后重试", true, null));
        return toOnline(row);
    }

    // ---------------------------------------------------------------- 内部

    private DoctorScheduleData view(DoctorRepository.DoctorRow doctor) {
        List<DoctorScheduleRepository.ScheduleRow> rows = repository.findByDoctorId(doctor.id());
        int version = rows.isEmpty() ? 0 : rows.get(0).version();
        Map<Integer, List<DoctorScheduleData.Slot>> byDay = new LinkedHashMap<>();
        for (var row : rows) {
            byDay.computeIfAbsent(row.weekday(), k -> new ArrayList<>())
                    .add(new DoctorScheduleData.Slot(format(row.startTime()), format(row.endTime()),
                            row.slotMinutes(), row.capacity(), row.onlineOnly()));
        }
        List<DoctorScheduleData.Day> days = byDay.entrySet().stream()
                .sorted(Map.Entry.comparingByKey())
                .map(e -> new DoctorScheduleData.Day(e.getKey(), e.getValue()))
                .toList();
        var online = repository.findOnline(doctor.id())
                .orElse(new DoctorScheduleRepository.OnlineRow(doctor.id(), false, false, 0, null));
        return new DoctorScheduleData(version, days, toOnline(online));
    }

    private static DoctorOnlineStatusData toOnline(DoctorScheduleRepository.OnlineRow row) {
        return new DoctorOnlineStatusData(row.online(), row.accepting(), row.version(), row.updatedAt());
    }

    /** 语义校验 + 归一（越界 422；同天重叠 422 SCHEDULE_OVERLAP）。 */
    private List<DoctorScheduleRepository.ScheduleRow> normalize(DoctorScheduleUpdateRequest request) {
        List<DoctorScheduleRepository.ScheduleRow> out = new ArrayList<>();
        Set<Integer> seenWeekdays = new java.util.HashSet<>();
        for (var day : request.weekdays()) {
            if (day == null || day.weekday() == null) {
                throw validation("weekday 不能为空");
            }
            int weekday = day.weekday();
            if (weekday < 1 || weekday > 7) {
                throw validation("weekday 取值 1~7（1=周一）");
            }
            if (!seenWeekdays.add(weekday)) {
                throw validation("weekday " + weekday + " 重复出现");
            }
            var slots = day.slots() == null ? List.<DoctorScheduleUpdateRequest.Slot>of() : day.slots();
            if (slots.size() > MAX_SLOTS_PER_DAY) {
                throw validation("每天最多 " + MAX_SLOTS_PER_DAY + " 个时段");
            }
            List<DoctorScheduleRepository.ScheduleRow> dayRows = new ArrayList<>();
            for (var slot : slots) {
                LocalTime start = parse(slot.startTime(), "startTime");
                LocalTime end = parse(slot.endTime(), "endTime");
                if (!start.isBefore(end)) {
                    throw validation("startTime 必须早于 endTime（weekday " + weekday + "）");
                }
                int slotMinutes = slot.slotMinutes() == null ? 30 : slot.slotMinutes();
                if (!ALLOWED_SLOT_MINUTES.contains(slotMinutes)) {
                    throw validation("slotMinutes 仅支持 10/15/20/30/60");
                }
                int capacity = slot.capacity() == null ? 1 : slot.capacity();
                if (capacity < 1 || capacity > 50) {
                    throw validation("capacity 取值 1~50");
                }
                dayRows.add(new DoctorScheduleRepository.ScheduleRow(null, null, weekday, start, end,
                        slotMinutes, capacity, Boolean.TRUE.equals(slot.onlineOnly()), 0));
            }
            dayRows.sort(Comparator.comparing(DoctorScheduleRepository.ScheduleRow::startTime));
            for (int i = 1; i < dayRows.size(); i++) {
                if (dayRows.get(i).startTime().isBefore(dayRows.get(i - 1).endTime())) {
                    throw new ApiException("SCHEDULE_OVERLAP", HttpStatus.UNPROCESSABLE_ENTITY,
                            "weekday " + weekday + " 的时段存在重叠：" + format(dayRows.get(i - 1).startTime())
                                    + "~" + format(dayRows.get(i - 1).endTime()) + " 与 "
                                    + format(dayRows.get(i).startTime()) + "~" + format(dayRows.get(i).endTime()));
                }
            }
            out.addAll(dayRows);
        }
        return out;
    }

    /** 内容比对（忽略 id/version）：用于判定"上次已保存成功、这是同一请求的重试"。 */
    private boolean sameAsStored(String doctorId,
                                 List<DoctorScheduleRepository.ScheduleRow> incoming) {
        List<DoctorScheduleRepository.ScheduleRow> stored = sorted(repository.findByDoctorId(doctorId));
        List<DoctorScheduleRepository.ScheduleRow> next = sorted(incoming);
        if (stored.size() != next.size()) {
            return false;
        }
        for (int i = 0; i < stored.size(); i++) {
            var a = stored.get(i);
            var b = next.get(i);
            if (a.weekday() != b.weekday()
                    || !a.startTime().equals(b.startTime())
                    || !a.endTime().equals(b.endTime())
                    || a.slotMinutes() != b.slotMinutes()
                    || a.capacity() != b.capacity()
                    || a.onlineOnly() != b.onlineOnly()) {
                return false;
            }
        }
        return true;
    }

    private static List<DoctorScheduleRepository.ScheduleRow> sorted(
            List<DoctorScheduleRepository.ScheduleRow> rows) {
        return rows.stream()
                .sorted(Comparator.comparingInt(DoctorScheduleRepository.ScheduleRow::weekday)
                        .thenComparing(DoctorScheduleRepository.ScheduleRow::startTime))
                .toList();
    }

    private Instant nextSlotAt(String doctorId) {
        List<DoctorScheduleRepository.ScheduleRow> rows = repository.findByDoctorId(doctorId);
        if (rows.isEmpty()) {
            return null;
        }
        ZoneId zone = ZoneId.systemDefault();
        // 排班时间是"本地墙上时间"：以部署机时区的现在为基准比较，再转成 Instant 下发
        LocalDateTime localNow = LocalDateTime.now(zone);
        for (int offset = 0; offset <= 7; offset++) {
            LocalDate date = localNow.toLocalDate().plusDays(offset);
            int weekday = date.getDayOfWeek().getValue();
            LocalDateTime earliest = null;
            for (var row : rows) {
                if (row.weekday() != weekday) {
                    continue;
                }
                LocalDateTime start = LocalDateTime.of(date, row.startTime());
                if (start.isAfter(localNow) && (earliest == null || start.isBefore(earliest))) {
                    earliest = start;
                }
            }
            if (earliest != null) {
                return earliest.atZone(zone).toInstant();
            }
        }
        return null;
    }

    private static LocalTime parse(String value, String field) {
        try {
            return LocalTime.parse(value);
        } catch (RuntimeException e) {
            throw validation(field + " 须为 HH:mm 格式");
        }
    }

    private static String format(LocalTime time) {
        return time == null ? null : String.format("%02d:%02d", time.getHour(), time.getMinute());
    }

    private static ApiException validation(String message) {
        return new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY, message);
    }
}
