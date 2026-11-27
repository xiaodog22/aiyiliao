package com.wechar.biz.payment.dto;

import jakarta.validation.constraints.NotBlank;

/**
 * 缴纳单笔院内侧费用（演示态）。
 *
 * <p>只传「哪个预约的哪张单」；金额由院内侧账单决定，客户端不可指定（防篡改）。
 */
public record PaymentBillPayRequest(@NotBlank String appointmentId, @NotBlank String chargeNo) {
}
