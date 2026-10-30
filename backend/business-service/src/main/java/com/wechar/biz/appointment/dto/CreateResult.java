package com.wechar.biz.appointment.dto;

/**
 * 创建预约结果：appointment + 是否幂等重放（决定响应头 Idempotency-Replayed）。
 */
public record CreateResult(AppointmentData appointment, boolean replayed) {
}
