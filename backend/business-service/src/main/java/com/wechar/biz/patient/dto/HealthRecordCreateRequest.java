package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * 契约 HealthRecordCreate（additionalProperties:false → 显式严格；required=[category, recordedAt]）。
 * attachmentKeys 引用已由上传流程校验为 AVAILABLE 的对象键（O-01 未定稿，M1 仅登记不内联传输）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HealthRecordCreateRequest(
        @jakarta.validation.constraints.Size(max = 64) String familyMemberId,
        @jakarta.validation.constraints.NotBlank @jakarta.validation.constraints.Size(max = 20) String category,
        @jakarta.validation.constraints.Size(max = 80) String title,
        @jakarta.validation.constraints.Size(max = 500) String summary,
        @jakarta.validation.constraints.NotNull Instant recordedAt,
        @jakarta.validation.constraints.Size(max = 120) String source,
        @jakarta.validation.constraints.Size(max = 40) String doctorName,
        Boolean abnormal,
        List<String> attachmentKeys
) {
}
