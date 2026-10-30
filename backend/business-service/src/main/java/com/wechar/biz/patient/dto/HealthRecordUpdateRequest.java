package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * PUT /api/v1/health-records/{recordId} 请求（契约外补充路径，复核要求）。
 * version 必填（乐观锁，与 Appointment/Profile 一致）；其余字段缺省保留原值。
 * 契约外补充路径，宽松收未知字段（见 JacksonStrictConfig）。
 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HealthRecordUpdateRequest(
        @jakarta.validation.constraints.NotNull Integer version,
        @jakarta.validation.constraints.Size(max = 20) String category,
        @jakarta.validation.constraints.Size(max = 80) String title,
        @jakarta.validation.constraints.Size(max = 500) String summary,
        Instant recordedAt
) {
}
