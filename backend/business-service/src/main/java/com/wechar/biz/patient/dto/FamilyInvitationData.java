package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 FamilyInvitation（required=[invitationId, token, expiresAt]）。
 * token 一次性、仅本响应返回；服务端只存 SHA-256（V3 family_invitations.token_hash）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FamilyInvitationData(
        String invitationId,
        String token,
        Instant expiresAt,
        String channel
) {
}
