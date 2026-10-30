package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * POST /api/v1/family-members/invitations 请求体（契约 inline schema，required=[relation]）。
 * channel 枚举 QRCODE / PHONE_DEEPLINK；phone 可选，服务端仅存哈希用于比对。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FamilyInvitationCreateRequest(
        @jakarta.validation.constraints.NotBlank @jakarta.validation.constraints.Size(max = 20) String relation,
        @jakarta.validation.constraints.Size(max = 20) String channel,
        @jakarta.validation.constraints.Size(max = 20) String phone
) {
}
