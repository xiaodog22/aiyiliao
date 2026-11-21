package com.wechar.biz.exam.dto;

/** 检查预约开关（P0-2）：关闭时页面只显示提示，不发起任何 HIS 调用。 */
public record ExamConfigData(boolean enabled, String mode, String source,
                             String disabledMessage, String demoNotice) {
}
