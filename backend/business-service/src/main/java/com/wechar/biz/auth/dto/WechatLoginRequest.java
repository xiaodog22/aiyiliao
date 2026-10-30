package com.wechar.biz.auth.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 契约 WechatLoginRequest（additionalProperties:false —— 显式关闭未知字段宽容）：
 * required=[code, consentVersion]；可选 phoneCode/deviceId。
 * consentVersion 是用户在独立界面实际看到的隐私政策版本；服务端校验非空即收
 * （版本登记在 consents 域完善，M1 不做"登录即同意"）。
 * 严格：{code, clientType} 这类契约外字段会被拒绝（400 BAD_REQUEST）。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record WechatLoginRequest(
        @NotBlank @Size(min = 8, max = 256) String code,
        @Size(max = 256) String phoneCode,
        @NotBlank @Size(min = 1, max = 20) String consentVersion,
        @Size(max = 64) String deviceId
) {
}
