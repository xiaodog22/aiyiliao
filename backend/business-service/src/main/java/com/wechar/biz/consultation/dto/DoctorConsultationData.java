package com.wechar.biz.consultation.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 医生视角问诊会话（/api/v1/doctor/consultations 列表项，V21 医生回复闭环）。
 * 与患者侧 ConsultationData 的区别：含患者姓名/头像（join users，供医生端识别就诊人）；
 * 不含医生卡字段（医生端不需要）。patientAvatarKey 可能为 null（用户未设头像）。
 * assignedDoctorId：null = 未分配（认领池，前端显示「接诊」）；非 null = 已分配（前端显示「回复」）。
 * accepting：是否已接诊（会话内已出现医生侧消息）。与 assignedDoctorId 不等价 ——
 *   患者指定医生发起的会话交付即 assignedDoctorId 非空，但医生尚未回复时 accepting=false，
 *   医生端据此显示「待接诊 / 正在接诊」，与患者端医生卡状态同源（2026-10-24）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorConsultationData(String id, String title, String status, Instant lastMessageAt,
                                     Integer messageCount, String summary, Instant createdAt,
                                     String patientName, String patientAvatarKey, String assignedDoctorId,
                                     Boolean accepting) {
}
