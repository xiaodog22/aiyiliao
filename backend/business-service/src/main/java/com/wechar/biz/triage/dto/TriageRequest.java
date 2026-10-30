package com.wechar.biz.triage.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

/** 契约 TriageRequest（必填 symptoms；客户端可能附带扩展字段，宽松收未知字段，见 JacksonStrictConfig）。 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TriageRequest(
        @NotBlank @Size(max = 1000) String symptoms,
        @Size(max = 60) String durationText,
        @Size(max = 20) String ageBand,
        List<String> localRuleHits,
        @Size(max = 40) String rulesetVersion
) {
}
