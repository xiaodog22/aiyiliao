package com.wechar.biz.user.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * PATCH /api/v1/me/account 请求体：账号基本信息（当前仅姓名）。
 * 与健康档案 PATCH /me/profile 分离：display_name 在 users 表。
 */
public record AccountUpdateRequest(
        @NotBlank(message = "姓名不能为空") @Size(max = 20, message = "姓名过长（最多 20 字）") String displayName
) {
}
