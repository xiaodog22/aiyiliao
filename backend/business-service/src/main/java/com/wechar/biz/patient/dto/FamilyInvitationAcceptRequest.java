package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * POST /api/v1/family-members/invitations/accept 请求体（DEF-04：把原先只有 Service 的
 * 接受邀请能力开放成契约端点）。
 *
 * 语义：邀请人创建邀请时拿到一次性 token（仅创建响应返回，库内只存 SHA-256），
 * 家人在场确认后由邀请人回填 token + 目标成员 → 该成员 proxyStatus 置 GRANTED。
 * token 一次性，重复提交返回 409 INVITATION_EXPIRED。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FamilyInvitationAcceptRequest(
        @jakarta.validation.constraints.NotBlank
        @jakarta.validation.constraints.Size(max = 128) String token,
        @jakarta.validation.constraints.NotBlank
        @jakarta.validation.constraints.Size(max = 64) String memberId
) {
}
