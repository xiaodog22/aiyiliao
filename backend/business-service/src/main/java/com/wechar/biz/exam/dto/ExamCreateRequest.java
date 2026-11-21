package com.wechar.biz.exam.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 建检查预约请求；金额不传，服务端取 HIS 项目价。 */
public record ExamCreateRequest(
        @NotBlank @Size(max = 32) String itemCode,
        @NotBlank @Size(max = 32) String slotKey,
        @NotBlank @Size(max = 50) String patientName,
        @Size(max = 64) String familyMemberId) {
}
