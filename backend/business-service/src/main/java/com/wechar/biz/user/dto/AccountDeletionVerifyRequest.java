package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 契约 AccountDeletionVerify（N10，2026-10-19；additionalProperties:false）：
 * required=[challengeId, code] —— 注销二次校验（N9 scene=ACCOUNT_DELETION 的短信验证码）。
 * 字段缺失/长度不符 → 422（契约 422 = 二次校验失败，含"需先验证码"）；
 * 码值错误/过期/手机号不匹配由服务层同转 422（业务校验口径一致）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record AccountDeletionVerifyRequest(
        @NotBlank(message = "challengeId 不能为空")
        @Size(min = 1, max = 64)
        String challengeId,
        @NotBlank(message = "code 不能为空")
        @Size(min = 6, max = 6, message = "code 须为 6 位验证码")
        String code
) {
}
