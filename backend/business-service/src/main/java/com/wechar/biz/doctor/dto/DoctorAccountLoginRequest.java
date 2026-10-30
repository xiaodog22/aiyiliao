package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;

/**
 * 契约 DoctorAccountLogin（N8，2026-10-19；additionalProperties:false）：
 * required=[account, credential, challengeId]。
 * 字段缺失走服务层 400（契约声明 400 参数缺失），不使用 Bean Validation 的 422 口径；
 * credential 错误/过期一律 401（不在 DTO 层做格式拦截，避免 400/401 差异成为穷举 oracle）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record DoctorAccountLoginRequest(String account, String credential, String challengeId) {
}
