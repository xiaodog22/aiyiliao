package com.wechar.biz.consultation.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.util.List;

/**
 * 契约 InputConfirmation。语音转写/图片识别在进入诊疗流程前必须由用户核对确认；
 * 与转写原文不一致时以 confirmedText 为准。
 */
public record InputConfirmationRequest(
        @NotBlank(message = "sourceTaskId 不能为空") @Size(max = 64) String sourceTaskId,
        @NotBlank(message = "confirmedText 不能为空") @Size(max = 2000) String confirmedText,
        List<@Size(max = 120) String> corrections) {
}
