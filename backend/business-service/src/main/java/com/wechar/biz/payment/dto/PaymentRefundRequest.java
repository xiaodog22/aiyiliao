package com.wechar.biz.payment.dto;

import jakarta.validation.constraints.Size;

/**
 * 演示退费请求（2026-11-21）。
 *
 * <p>只有 reason 一个字段，且仅用于审计/页面回显；金额、状态一律由服务端按订单决定，
 * 不接受客户端传入（避免“客户端指定退款金额”这类越权面）。
 */
public record PaymentRefundRequest(
        @Size(max = 100, message = "退费原因最多 100 字") String reason) {
}
