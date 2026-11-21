package com.wechar.biz.exam.dto;

import java.math.BigDecimal;

/** 检查项目（P0-2）；demo=true 表示演示库项目价。 */
public record ExamItemData(String itemCode, String itemName, String category,
                           BigDecimal price, boolean demo) {
}
