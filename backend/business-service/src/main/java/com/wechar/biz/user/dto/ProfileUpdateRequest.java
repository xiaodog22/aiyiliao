package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;
import java.time.LocalDate;

/** PATCH /api/v1/me/profile 请求（任务书 ProfileUpdateRequest；所有字段可选，version 乐观锁可选；契约外补充路径宽松收未知字段，见 JacksonStrictConfig）。 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ProfileUpdateRequest(
        LocalDate birthDate,
        @Size(max = 8) String sex,
        @Min(30) @Max(300) BigDecimal heightCm,
        @Min(20) @Max(500) BigDecimal weightKg,
        @Size(max = 500) String allergies,
        @Size(max = 500) String chronicConditions,
        Integer version
) {
}
