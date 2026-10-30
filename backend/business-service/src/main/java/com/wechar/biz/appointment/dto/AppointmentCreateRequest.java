package com.wechar.biz.appointment.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 契约 AppointmentCreate（必填 slotId + patientName；本路径宽松收未知字段，见 JacksonStrictConfig）。 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AppointmentCreateRequest(
        @NotBlank @Size(max = 64) String slotId,
        @Size(max = 64) String familyMemberId,
        @NotBlank @Size(max = 40) String patientName,
        @Size(max = 20) String contactPhone,
        @Size(max = 300) String symptomSummary
) {
}
