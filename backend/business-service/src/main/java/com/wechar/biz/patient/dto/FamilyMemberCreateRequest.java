package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 FamilyMemberCreate（additionalProperties:false → 严格；required=[displayName, relation]）。 */
@JsonIgnoreProperties(ignoreUnknown = false)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record FamilyMemberCreateRequest(
        @jakarta.validation.constraints.NotBlank @jakarta.validation.constraints.Size(max = 40) String displayName,
        @jakarta.validation.constraints.NotBlank @jakarta.validation.constraints.Size(max = 20) String relation,
        @jakarta.validation.constraints.Size(max = 20) String ageBand,
        @jakarta.validation.constraints.Size(max = 8) String gender,
        @jakarta.validation.constraints.Size(max = 20) String phone
) {
}
