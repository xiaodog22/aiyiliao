package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 PatientUpdate（additionalProperties:false；required=[version]）。
 *
 * 只允许改 displayName / birthDate / sex / idCardNumber / phone；
 * patientRef 与 familyMemberId 不可改（换家人应新建就诊人，改名不换 ref）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PatientUpdateRequest(
        @jakarta.validation.constraints.NotNull
        @jakarta.validation.constraints.Min(1) Integer version,
        @jakarta.validation.constraints.Size(max = 40) String displayName,
        @jakarta.validation.constraints.Pattern(regexp = "^\\d{4}-\\d{2}-\\d{2}$",
                message = "birthDate 须为 YYYY-MM-DD") String birthDate,
        @jakarta.validation.constraints.Size(max = 8) String sex,
        @jakarta.validation.constraints.Size(max = 18) String idCardNumber,
        @jakarta.validation.constraints.Pattern(regexp = "^1[3-9][0-9]{9}$",
                message = "phone 须为 11 位大陆手机号") String phone
) {
}
