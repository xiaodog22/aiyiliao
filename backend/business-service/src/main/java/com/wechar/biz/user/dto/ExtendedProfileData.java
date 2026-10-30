package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 个人信息扩展资料（GET/PUT /api/v1/me/extended）。
 * 证件号/医保号只下发掩码与绑定状态，原文/密文永不回显。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ExtendedProfileData(
        String email,
        String residence,
        String householdRegistration,
        String idCardName,
        String idCardMasked,
        Boolean idCardVerified,
        String insuranceType,
        String insuranceMasked,
        Boolean insuranceBound,
        Integer version
) {
}
