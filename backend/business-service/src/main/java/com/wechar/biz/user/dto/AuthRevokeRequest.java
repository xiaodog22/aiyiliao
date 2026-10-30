package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 契约 AuthRevokeRequest（N11，2026-10-19；additionalProperties:false）：
 * required=[scope]，scope ∈ PROFILE | HEALTH_RECORDS | FAMILY（非法取值 → 422）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record AuthRevokeRequest(
        @NotBlank(message = "scope 不能为空")
        @Pattern(regexp = "PROFILE|HEALTH_RECORDS|FAMILY", message = "scope 仅支持 PROFILE / HEALTH_RECORDS / FAMILY")
        @Size(max = 32)
        String scope
) {
}
