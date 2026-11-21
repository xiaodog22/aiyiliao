package com.wechar.biz.payment.dto;

/** 支付能力快照：页面据此决定显示「演示支付」还是「请到院窗口缴费」。 */
public record PaymentConfigData(boolean enabled, String mode, String source,
                                String disabledMessage, String successMessage) {
}
