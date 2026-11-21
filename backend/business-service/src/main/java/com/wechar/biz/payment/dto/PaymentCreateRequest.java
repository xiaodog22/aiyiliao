package com.wechar.biz.payment.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/** 建单请求：只收预约 ID，金额一律由服务端按号源费确定。 */
public record PaymentCreateRequest(
        @NotBlank @Size(max = 64) String appointmentId) {
}
