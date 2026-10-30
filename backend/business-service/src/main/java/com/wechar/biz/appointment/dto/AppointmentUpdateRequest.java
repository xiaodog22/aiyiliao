package com.wechar.biz.appointment.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * PATCH /api/v1/appointments/{id} 请求（任务书 AppointmentUpdate；version 必填乐观锁）。
 * 可更新 symptomSummary / familyMemberId / contactPhoneCipher（同手机加密逻辑）。
 * PATCH 为契约外补充路径，宽松收未知字段（见 JacksonStrictConfig）。
 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AppointmentUpdateRequest(
        @NotNull Integer version,
        @Size(max = 300) String symptomSummary,
        @Size(max = 64) String familyMemberId,
        @Size(max = 20) String contactPhone
) {
}
