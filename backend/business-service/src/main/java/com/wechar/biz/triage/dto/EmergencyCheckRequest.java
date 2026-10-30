package com.wechar.biz.triage.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 契约 /triage/emergency-checks 请求体（必填 text；宽松收未知字段，见 JacksonStrictConfig）。 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EmergencyCheckRequest(
        @NotBlank @Size(max = 500) String text,
        @Size(max = 20) String locale
) {
}
