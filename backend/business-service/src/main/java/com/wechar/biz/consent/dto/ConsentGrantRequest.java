package com.wechar.biz.consent.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * 契约 ConsentGrantRequest：required=[purpose, policyVersion, channel]；
 * scope 可选（同意覆盖的数据范围标签）、evidenceDigest ≤128（确认动作证据摘要，不存原始截图）。
 * 契约声明 additionalProperties:false → 保持严格（未知字段 → 400，全局严格反序列化生效）。
 * 枚举取值校验在服务层（契约该路径声明 422）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record ConsentGrantRequest(
        @NotBlank String purpose,
        @NotBlank @Size(max = 20) String policyVersion,
        List<String> scope,
        @NotBlank String channel,
        @Size(max = 128) String evidenceDigest) {
}
