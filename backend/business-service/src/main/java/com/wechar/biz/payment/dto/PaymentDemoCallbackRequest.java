package com.wechar.biz.payment.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/** 演示回调载荷（本地模拟，不含微信支付字段）。 */
public record PaymentDemoCallbackRequest(
        @NotBlank @Size(max = 32) String orderNo,
        @NotBlank @Size(max = 64) String chargeNo,
        @NotNull BigDecimal amount,
        @NotBlank @Size(max = 16) String source) {
}
