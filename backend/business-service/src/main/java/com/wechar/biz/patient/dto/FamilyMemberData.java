package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 FamilyMember（additionalProperties:false；required=[id, displayName, relation, proxyStatus]）。
 * proxyStatus：NONE/PENDING/GRANTED/REVOKED —— 添加成员时服务端恒为 NONE（添加 ≠ 获权）。
 * gender：MALE/FEMALE/UNKNOWN；phoneMasked 为脱敏展示号（138****0001），明文手机号只存哈希。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FamilyMemberData(
        String id,
        String displayName,
        String relation,
        String proxyStatus,
        String ageBand,
        String gender,
        String phoneMasked,
        String avatarUrl
) {
}
