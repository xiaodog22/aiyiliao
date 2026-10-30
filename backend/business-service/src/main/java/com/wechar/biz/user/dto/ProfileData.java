package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;

/**
 * GET /me 与 PATCH /me/profile 的档案对象（V1 user_profiles 字段对齐 + 乐观锁 version）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProfileData(
        LocalDate birthDate,
        String sex,
        BigDecimal heightCm,
        BigDecimal weightKg,
        String allergies,
        String chronicConditions,
        Integer version,
        Instant updatedAt
) {
}
