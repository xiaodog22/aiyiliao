package com.wechar.biz.payment.dto;

import java.math.BigDecimal;
import java.time.Instant;

/** 演示支付订单（对外只暴露脱敏字段；不含患者姓名/诊断）。 */
public record PaymentOrderData(String orderNo, String appointmentId, String chargeNo,
                               BigDecimal amount, String currency, String status, String source,
                               boolean demo, Instant createdAt, Instant paidAt,
                               Instant refundedAt, String refundReason) {
}
