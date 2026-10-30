package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * 契约 DoctorScheduleUpdate（V22）：整体替换医生周模板。
 *
 * 语义：**整体替换**（不是增量补丁）——请求里没有的天/时段会被删除。
 * expectedVersion 乐观锁：无排班传 0；与当前版本不符 → 409 VERSION_CONFLICT
 * （唯一例外：上次替换已成功且内容完全一致 → 视为幂等重放，回 200）。
 *
 * 字段约束（越界 → 422 VALIDATION_FAILED / SCHEDULE_OVERLAP）：
 *  - weekday 1..7 且不重复；每天最多 8 段；
 *  - startTime/endTime 为 `HH:mm`，start < end；
 *  - slotMinutes ∈ {10,15,20,30,60}；capacity 1..50；
 *  - 同一天时段不得重叠。
 */
public record DoctorScheduleUpdateRequest(
        @NotNull(message = "expectedVersion 不能为空")
        @Min(value = 0, message = "expectedVersion 不能为负")
        Integer expectedVersion,
        @NotNull(message = "weekdays 不能为空")
        @Size(max = 7, message = "weekdays 最多 7 天")
        List<@Valid Day> weekdays) {

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Day(
            @NotNull(message = "weekday 不能为空")
            @Min(value = 1, message = "weekday 取值 1~7")
            @Max(value = 7, message = "weekday 取值 1~7")
            Integer weekday,
            @NotNull(message = "slots 不能为空")
            @Size(max = 8, message = "每天最多 8 个时段")
            List<@Valid Slot> slots) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Slot(
            @NotBlank(message = "startTime 不能为空")
            @Pattern(regexp = "^([01]\\d|2[0-3]):[0-5]\\d$", message = "startTime 须为 HH:mm")
            String startTime,
            @NotBlank(message = "endTime 不能为空")
            @Pattern(regexp = "^([01]\\d|2[0-3]):[0-5]\\d$", message = "endTime 须为 HH:mm")
            String endTime,
            @NotNull(message = "slotMinutes 不能为空") Integer slotMinutes,
            @NotNull(message = "capacity 不能为空") Integer capacity,
            Boolean onlineOnly) {
    }
}
