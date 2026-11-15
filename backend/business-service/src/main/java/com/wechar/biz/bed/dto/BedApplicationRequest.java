package com.wechar.biz.bed.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 床位申请请求（申请制，2026-11-15）。
 *
 * required=[patientRef]：
 *   · patientRef 用**内部患者 ID**，与 beds.occupant_user_id 同口径；
 *     手机号/姓名一律 422（与 BedAssignmentRequest 的 ASSIGN 约束保持一致）。
 * 可选项：
 *   · bedId   指定床位时校验「属于当前医生授权病区 + 当前为空闲」，审批通过后直接落床；
 *   · wardId  只申请病区（不指定床位）时由护士站排床；
 *   · reason  病情/申请说明 ≤200；
 *   · priority NORMAL / URGENT（默认 NORMAL）。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record BedApplicationRequest(
        @NotBlank String patientRef,
        String bedId,
        String wardId,
        @Size(max = 200) String reason,
        String priority) {

    public static final String PRIORITY_NORMAL = "NORMAL";
    public static final String PRIORITY_URGENT = "URGENT";

    /** 归一化后的优先级：无法识别一律按普通处理，不臆造新档位。 */
    public String normalizedPriority() {
        String p = priority == null ? "" : priority.trim().toUpperCase();
        return PRIORITY_URGENT.equals(p) ? PRIORITY_URGENT : PRIORITY_NORMAL;
    }
}
