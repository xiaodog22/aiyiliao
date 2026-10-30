package com.wechar.biz.triage.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.util.List;

/** 契约 EmergencyCheck（必填 emergency/matchedRules）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record EmergencyCheckData(Boolean emergency, String level, List<String> matchedRules,
                                 String rulesetVersion, String advice) {
}
