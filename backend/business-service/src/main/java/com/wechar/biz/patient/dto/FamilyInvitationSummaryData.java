package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 FamilyInvitationSummary（GET /api/v1/family-members/invitations 的元素）。
 * 只回邀请元数据：token/tokenHash/phoneHash 一律不下发（令牌仅在创建响应出现一次）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FamilyInvitationSummaryData(
        String invitationId,
        String relation,
        String channel,
        String status,
        Instant expiresAt,
        Instant createdAt
) {
}
