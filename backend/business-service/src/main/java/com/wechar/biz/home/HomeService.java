package com.wechar.biz.home;

import com.wechar.biz.appointment.AppointmentRepository;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.content.ContentService;
import com.wechar.biz.content.dto.ContentItemData;
import com.wechar.biz.home.dto.HomeBriefData;
import com.wechar.biz.home.dto.HomeBlockData;
import com.wechar.biz.home.dto.HomeServiceItem;
import com.wechar.biz.home.dto.HomeSummaryData;
import com.wechar.biz.user.UserRepository;
import java.time.Clock;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 首页聚合服务（M1.5 / 任务书规则 8）：
 *  - 未绑定手机 → reminderType=BIND_PHONE；
 *  - 绑定且有近期预约 → UPCOMING_APPOINTMENT（带 appointmentId）；
 *  - 绑定且无 → AI_GUIDANCE；
 *  - 问候语按 Asia/Shanghai（00:00–05:59 特殊文案）；
 *  - 只返回首屏展示所必需字段（不返回健康明细/报告正文）。
 */
@Service
public class HomeService {

    public static final String REMINDER_BIND_PHONE = "BIND_PHONE";
    public static final String REMINDER_UPCOMING_APPOINTMENT = "UPCOMING_APPOINTMENT";
    public static final String REMINDER_AI_GUIDANCE = "AI_GUIDANCE";

    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");
    private static final DateTimeFormatter HOUR = DateTimeFormatter.ofPattern("HH");

    private final UserRepository userRepository;
    private final AppointmentRepository appointmentRepository;
    private final AuthService authService;
    private final ContentService contentService;
    private final HomeBlockConfigRepository blockConfig;
    private final Clock clock;

    public HomeService(UserRepository userRepository, AppointmentRepository appointmentRepository,
                       AuthService authService, ContentService contentService,
                       HomeBlockConfigRepository blockConfig, Clock clock) {
        this.userRepository = userRepository;
        this.appointmentRepository = appointmentRepository;
        this.authService = authService;
        this.contentService = contentService;
        this.blockConfig = blockConfig;
        this.clock = clock;
    }

    /** 与前端 SERVICES 的 key 一一对应的兜底入口（配置表为空/不可读时不让首页变空）。 */
    private static final List<HomeServiceItem> DEFAULT_SERVICES = List.of(
            new HomeServiceItem("triage", "智能导诊", "svc-triage"),
            new HomeServiceItem("doctor", "找医生", "svc-doctor"),
            new HomeServiceItem("dept", "找科室", "svc-dept"),
            new HomeServiceItem("archive", "健康档案", "svc-archive"),
            new HomeServiceItem("checkup", "体检服务", "svc-checkup"),
            new HomeServiceItem("care", "居家护理", "svc-care"),
            new HomeServiceItem("advice", "健康咨询", "svc-advice"),
            new HomeServiceItem("more", "更多服务", "svc-more"));

    /** 任务书路径 GET /api/v1/home 的聚合。 */
    @Transactional // 非只读：ensureUser 首次访问需补建 users/user_profiles
    public HomeBriefData brief(String rawUserId) {
        String userId = authService.ensureUser(rawUserId);
        var user = userRepository.findById(userId).orElse(null);
        boolean phoneBound = user != null && user.phoneBound();

        var upcoming = appointmentRepository.nextUpcomingViewForUser(userId, clock.instant()).orElse(null);

        String reminderType;
        String appointmentId = null;
        if (!phoneBound) {
            reminderType = REMINDER_BIND_PHONE;
        } else if (upcoming != null) {
            reminderType = REMINDER_UPCOMING_APPOINTMENT;
            appointmentId = upcoming.appt().id();
        } else {
            reminderType = REMINDER_AI_GUIDANCE;
        }
        return new HomeBriefData(greeting(), reminderType, appointmentId);
    }

    /** 契约路径 GET /api/v1/home/summary（HomeSummary：greeting + blocks）。 */
    @Transactional // 非只读：ensureUser 首次访问需补建 users/user_profiles
    public HomeSummaryData summary(String rawUserId) {
        String userId = authService.ensureUser(rawUserId);
        List<HomeBlockData> blocks = new ArrayList<>();

        var upcoming = appointmentRepository.nextUpcomingViewForUser(userId, clock.instant()).orElse(null);
        if (upcoming != null) {
            var a = upcoming.appt();
            var apptData = new com.wechar.biz.appointment.dto.AppointmentData(
                    a.id(), a.status(), a.slotId(), a.doctorId(), upcoming.doctorName(),
                    upcoming.doctorTitle(), a.departmentId(), upcoming.departmentName(),
                    a.patientName(), null, null,
                    upcoming.startTime(), upcoming.endTime(), a.queueNumber(),
                    upcoming.location(), upcoming.hospitalName(), a.symptomSummary(),
                    a.version(), null, a.createdAt(), a.updatedAt());
            blocks.add(new HomeBlockData("NEXT_APPOINTMENT", "ok", apptData, null, null));
        }

        blocks.add(new HomeBlockData("QUICK_SERVICES", "ok", null, null, quickServices()));

        List<ContentItemData> contents;
        try {
            contents = contentService.list(null, null, 3);
        } catch (RuntimeException e) {
            contents = List.of();
            blocks.add(new HomeBlockData("CONTENT_FEED", "unavailable", null, null, null));
            return new HomeSummaryData(greeting(), blocks);
        }
        blocks.add(new HomeBlockData("CONTENT_FEED", "ok", null, contents, null));

        return new HomeSummaryData(greeting(), blocks);
    }

    /** QUICK_SERVICES：优先读运营配置（home_block_config），缺省回退 8 项内置（与前端 SERVICES 对齐）。 */
    private List<HomeServiceItem> quickServices() {
        List<HomeBlockConfigRepository.ItemRow> rows = blockConfig.listEnabled("QUICK_SERVICES");
        if (rows.isEmpty()) {
            return DEFAULT_SERVICES;
        }
        return rows.stream()
                .map(r -> new HomeServiceItem(r.itemCode(), r.label(), r.iconKey()))
                .toList();
    }

    /** 问候语：Asia/Shanghai 时区；00:00–05:59 凌晨特殊文案。 */
    String greeting() {
        int hour = java.time.LocalTime.now(clock.withZone(ZONE)).getHour();
        if (hour < 6) {
            return "夜深了，注意休息";
        }
        if (hour < 12) {
            return "早上好";
        }
        if (hour < 14) {
            return "中午好";
        }
        if (hour < 18) {
            return "下午好";
        }
        return "晚上好";
    }
}
