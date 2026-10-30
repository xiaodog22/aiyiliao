package com.wechar.biz.consultation.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 医生回复问诊请求（V21 医生回复闭环；content 为纯文本回复）。 */
public record DoctorReplyRequest(
        @NotBlank(message = "content 不能为空") @Size(max = 2000) String content) {
}
