package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 PatientCreate（additionalProperties:false → 严格；required=[displayName]）。
 *
 * C3-②（硬约束）：归属只认 Authorization 解析出的 userId。
 * 请求体里出现 userId / ownerUserId / owner 等归属字段一律 422（ignoreUnknown=false 把未知字段变校验失败），
 * 不允许客户端指定「这条记录属于谁」。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PatientCreateRequest(
        @jakarta.validation.constraints.NotBlank
        @jakarta.validation.constraints.Size(max = 40) String displayName,
        @jakarta.validation.constraints.Size(max = 64) String familyMemberId,
        @jakarta.validation.constraints.Pattern(regexp = "^\\d{4}-\\d{2}-\\d{2}$",
                message = "birthDate 须为 YYYY-MM-DD") String birthDate,
        @jakarta.validation.constraints.Size(max = 8) String sex,
        @jakarta.validation.constraints.Size(max = 18) String idCardNumber,
        @jakarta.validation.constraints.Pattern(regexp = "^1[3-9][0-9]{9}$",
                message = "phone 须为 11 位大陆手机号") String phone
) {
}
