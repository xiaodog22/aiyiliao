package com.wechar.biz.exam.dto;

import java.math.BigDecimal;
import java.time.Instant;

/** 检查预约单（P0-2）；source 恒为 DEMO，页面必须标「演示预约」。 */
public record ExamOrderData(String requestNo, String examOrderNo,
                            String itemCode, String itemName, BigDecimal price,
                            String slotKey, String slotDate, String slotTime,
                            String status, String source, boolean replayed,
                            Instant createdAt) {
}
