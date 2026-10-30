package com.wechar.biz.consultation.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 契约 MessageCreate。confirmedInputId 携带时表示本条内容基于用户核对过的输入。 */
public record MessageCreateRequest(
        @NotBlank(message = "content 不能为空") @Size(max = 2000) String content,
        @Size(max = 10) String inputMode,
        @Size(max = 20) String requestedProfile,
        @Size(max = 64) String confirmedInputId) {
}
