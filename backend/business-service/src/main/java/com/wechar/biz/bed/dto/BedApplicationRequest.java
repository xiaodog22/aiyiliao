package com.wechar.biz.bed.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.Size;

/**
 * 床位申请请求（申请制，2026-11-15）。
 *
 * 患者二选一（服务端校验至少一个）：
 *   · appointmentId 医生本人名下的预约 ID —— 前端从“近期接诊患者”选择后直接传预约 ID，
 *     服务端解析为内部患者 ID，医生不再需要抄写 patientRef；
 *   · patientRef    内部患者 ID —— 兜底入口，与 beds.occupant_user_id 同口径；
 *     手机号/姓名一律 422（与 BedAssignmentRequest 的 ASSIGN 约束保持一致）。
 *   ⚠️ 两者不能同时传，避免“选了 A 患者却用 B 的 ID 提交”的歧义。
 * 可选项：
 *   · bedId   指定床位时校验「属于当前医生授权病区 + 当前为空闲」，审批通过后直接落床；
 *   · wardId  只申请病区（不指定床位）时由护士站排床；
 *   · reason  病情/申请说明 ≤200；
 *   · priority NORMAL / URGENT（默认 NORMAL）。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record BedApplicationRequest(
        String patientRef,
        String appointmentId,
        String bedId,
        String wardId,
        @Size(max = 200) String reason,
        String priority) {

    public static final String PRIORITY_NORMAL = "NORMAL";
    public static final String PRIORITY_URGENT = "URGENT";

    /** 兼容旧调用方（测试/既有代码）的 5 参数构造：不传 appointmentId。 */
    public BedApplicationRequest(String patientRef, String bedId, String wardId,
                                 String reason, String priority) {
        this(patientRef, null, bedId, wardId, reason, priority);
    }

    /** 归一化后的优先级：无法识别一律按普通处理，不臆造新档位。 */
    public String normalizedPriority() {
        String p = priority == null ? "" : priority.trim().toUpperCase();
        return PRIORITY_URGENT.equals(p) ? PRIORITY_URGENT : PRIORITY_NORMAL;
    }
}
