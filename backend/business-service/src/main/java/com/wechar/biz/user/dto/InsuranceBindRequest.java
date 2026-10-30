package com.wechar.biz.user.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

/**
 * POST /api/v1/me/insurance 请求体：医保绑定。
 * insuranceType 受枚举约束（职工/居民/其他）；insuranceNo 限字母数字 6~30 位。
 */
public record InsuranceBindRequest(
        @NotBlank(message = "医保类型不能为空")
        @Pattern(regexp = "^(职工基本医疗保险|城乡居民基本医疗保险|其他)$", message = "医保类型不正确")
        String insuranceType,
        @NotBlank(message = "医保号不能为空")
        @Pattern(regexp = "^[A-Za-z0-9]{6,30}$", message = "医保号须为 6~30 位字母或数字")
        String insuranceNo
) {
}
