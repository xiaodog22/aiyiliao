package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/**
 * 契约 DoctorSchedule（V22，2026-10-22）：医生周模板 + 实时在线状态。
 *
 * 字段口径：
 *  - version：**医生级**排班版本（同一医生所有行共享）；无排班时为 0（首次保存 expectedVersion 传 0）。
 *  - weekdays：只包含**有排班的天**（无排班的天不下发，客户端不要自造空时段）；
 *  - slot.startTime/endTime：`HH:mm` 本地墙上时间（不含时区）；
 *  - online：实时开关（见 DoctorOnlineStatusData），与排班版本互不影响。
 *
 * 医生本人可读写；患者侧只读 availability（见 DoctorAvailabilityData）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorScheduleData(int version, List<Day> weekdays, DoctorOnlineStatusData online) {

    /** 一天的排班：weekday=1(周一) … 7(周日)。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Day(int weekday, List<Slot> slots) {
    }

    /**
     * 单个出诊时段。
     * capacity=每个号源可约人数；onlineOnly=true 表示该时段仅接在线问诊（不生成线下号源）。
     */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Slot(String startTime, String endTime, int slotMinutes, int capacity, boolean onlineOnly) {
    }
}
