package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;

/**
 * 契约 User（additionalProperties:false：id/displayName/avatarUrl/gender/birthDate/
 * profileCompleteness/roles/phoneBound/maskedPhone/consents/createdAt/updatedAt）。
 * roles 一律由服务端下发（M1 患者端恒为 PATIENT）。
 * 本对象不回显手机号本身（phoneBound 只是布尔；maskedPhone 为 138****1234 掩码，F8）；
 * gender 缺失时为 UNKNOWN，birthDate 可为 null。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record UserData(
        String id,
        String displayName,
        String avatarUrl,
        String gender,
        LocalDate birthDate,
        Integer profileCompleteness,
        List<String> roles,
        Boolean phoneBound,
        String maskedPhone,
        List<Object> consents,
        Instant createdAt,
        Instant updatedAt
) {
}
