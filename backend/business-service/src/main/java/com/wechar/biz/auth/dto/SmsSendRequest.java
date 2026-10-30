package com.wechar.biz.auth.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * 契约 sendSmsChallenge（N9，2026-10-19）请求体（additionalProperties:false）：
 * required=[phone, scene]；phone 受 11 位大陆号码正则约束，scene 为枚举
 * DOCTOR_LOGIN（N8 医生登录）| ACCOUNT_DELETION（N10 账号注销二次校验）——
 * 取值不符 → 422 VALIDATION_FAILED，验证码按场景隔离、不得跨场景复用。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record SmsSendRequest(
        @NotBlank(message = "phone 不能为空")
        @Pattern(regexp = "^1[3-9]\\d{9}$", message = "phone 须为 11 位大陆手机号")
        String phone,
        @NotBlank(message = "scene 不能为空")
        @Pattern(regexp = "DOCTOR_LOGIN|ACCOUNT_DELETION", message = "scene 仅支持 DOCTOR_LOGIN / ACCOUNT_DELETION")
        @Size(max = 32)
        String scene
) {
}
