package com.wechar.biz.user.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * POST /api/v1/me/identity 请求体：身份证实名绑定。
 * idCardNumber 为 18 位（含校验码），服务端做 GB 11643 校验码验证后密文落库。
 */
public record IdentityBindRequest(
        @NotBlank(message = "姓名不能为空") @Size(max = 40, message = "姓名过长") String name,
        @NotBlank(message = "身份证号不能为空") @Size(max = 18, message = "身份证号须为 18 位") String idCardNumber
) {
}
