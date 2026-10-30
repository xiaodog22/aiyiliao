package com.wechar.biz.appointment.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 Appointment（additionalProperties:false：id/status/slotId/doctorId/departmentId/version/createdAt 必填）。
 * replayed 仅创建接口返回（契约允许的可选字段）。
 * location/hospitalName 为下单时的科室位置快照（科室搬迁不影响历史记录）；
 * symptomSummary 为主诉回显（属敏感健康信息，仅回给本人/经授权代管人）。
 *
 * V21（2026-10-21 医生-患者互通）新增三字段：
 *  - doctorTitle：医生职称（医生端/患者端列表展示，契约 §Appointment 2026-10-21 补）；
 *  - patientPhoneMasked：患者手机号脱敏值（医生接诊需要；明文只在服务端解密后脱敏，绝不下发）；
 *  - patientAvatarUrl：患者头像相对路径（/api/v1/avatars/<name>，匿名可读；无头像为 null，
 *    客户端用内置默认头像，与契约 Doctor.avatarUrl 同语义）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AppointmentData(
        String id,
        String status,
        String slotId,
        String doctorId,
        String doctorName,
        String doctorTitle,
        String departmentId,
        String departmentName,
        String patientName,
        String patientPhoneMasked,
        String patientAvatarUrl,
        Instant startTime,
        Instant endTime,
        Integer queueNumber,
        String location,
        String hospitalName,
        String symptomSummary,
        Integer version,
        Boolean replayed,
        Instant createdAt,
        Instant updatedAt
) {
}
