package com.wechar.biz.user.dto;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.Size;

/**
 * PUT /api/v1/me/extended 请求体：三字段均可选，null = 保留原值。
 * email 走 Bean Validation 格式校验；住址/户籍为自由文本（限长）。
 */
public record ExtendedProfileUpdateRequest(
        @Email(message = "邮箱格式不正确") @Size(max = 120, message = "邮箱过长") String email,
        @Size(max = 200, message = "住宅地址过长") String residence,
        @Size(max = 200, message = "户籍所在地过长") String householdRegistration
) {
}
