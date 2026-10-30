package com.wechar.biz.doctor;

import com.wechar.biz.common.ApiException;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.HttpStatus;

/**
 * 挂号状态机（契约 AppointmentStatus + updateAppointmentStatus："状态机驱动，
 * 服务端校验合法转换；非法转换返回 409 而不是静默忽略"）。
 *
 * 转换表（M3 口径，登记于任务回执：契约只给了枚举与"状态机驱动"的约束，未逐条列出允许的转换，
 * 故此处按"必须经过签到才能完成"的就诊顺序固化，其余一律 409）：
 *   PENDING    → CONFIRMED / CHECKED_IN / CANCELLED / NO_SHOW / EXPIRED
 *   CONFIRMED  → CHECKED_IN / CANCELLED / NO_SHOW / EXPIRED
 *   CHECKED_IN → COMPLETED / CANCELLED
 *   COMPLETED / CANCELLED / NO_SHOW / EXPIRED → 终态，不可再流转（含"流转到自身"）
 */
public final class AppointmentStatusMachine {

    /** 契约 AppointmentStatus 全集。 */
    public static final Set<String> ALL = Set.of("PENDING", "CONFIRMED", "CHECKED_IN", "COMPLETED",
            "CANCELLED", "NO_SHOW", "EXPIRED");

    private static final Map<String, Set<String>> TRANSITIONS = Map.of(
            "PENDING", Set.of("CONFIRMED", "CHECKED_IN", "CANCELLED", "NO_SHOW", "EXPIRED"),
            "CONFIRMED", Set.of("CHECKED_IN", "CANCELLED", "NO_SHOW", "EXPIRED"),
            "CHECKED_IN", Set.of("COMPLETED", "CANCELLED"),
            "COMPLETED", Set.of(),
            "CANCELLED", Set.of(),
            "NO_SHOW", Set.of(),
            "EXPIRED", Set.of());

    private AppointmentStatusMachine() {
    }

    public static boolean isKnownStatus(String status) {
        return status != null && ALL.contains(status);
    }

    /** 合法转换校验：非法（含终态、含流转到自身、含未知枚举）→ 409 APPOINTMENT_STATUS_INVALID。 */
    public static void requireTransition(String from, String to) {
        if (!isKnownStatus(to)) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "toStatus 取值不在 AppointmentStatus 枚举内，不得臆造状态");
        }
        if (from == null || !TRANSITIONS.getOrDefault(from, Set.of()).contains(to)) {
            throw new ApiException("APPOINTMENT_STATUS_INVALID", HttpStatus.CONFLICT,
                    "不允许的状态转换：" + from + " → " + to, false,
                    List.of(new com.wechar.biz.common.GlobalExceptionHandler.ErrorDetail(
                            "toStatus", "当前状态 " + from + " 不允许转换为 " + to, "APPOINTMENT_STATUS_INVALID")));
        }
    }
}
