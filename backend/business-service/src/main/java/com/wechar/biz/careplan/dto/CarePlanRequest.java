package com.wechar.biz.careplan.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * 契约 CarePlanRequest（additionalProperties:false 由全局严格反序列化保证）。
 * constraints 属健康信息，不进入埋点/日志正文。
 *
 * ageBand（2026-10-17 补）：前端养生页按年龄分档展示（age_group），但精确年龄属最小必要之外的
 * 信息 —— 只收 child/adult/elderly 三档，不落生日、不进日志；缺省时按 adult 处理。
 */
public record CarePlanRequest(
        @NotBlank(message = "goal 不能为空") @Size(max = 300) String goal,
        List<@Size(max = 60) String> constraints,
        @Size(max = 20) String locale,
        @Pattern(regexp = "child|adult|elderly", message = "ageBand 仅接受 child/adult/elderly")
        String ageBand) {
}
