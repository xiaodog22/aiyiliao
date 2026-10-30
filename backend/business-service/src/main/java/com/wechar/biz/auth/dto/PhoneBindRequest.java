package com.wechar.biz.auth.dto;

import jakarta.validation.constraints.Size;

/**
 * POST /api/v1/auth/phone/bind 请求（契约未列此路径，字段语义按任务书 M1 规则 2）。
 * 二选一：phoneCode（微信 getPhoneNumber 动态令牌，生产路径）或 phone（dev 直传明文，仅 11 位校验）。
 * 契约外补充路径，宽松收未知字段（见 JacksonStrictConfig）。
 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
public record PhoneBindRequest(
        @Size(max = 256) String phoneCode,
        @Size(max = 20) String phone
) {
}
