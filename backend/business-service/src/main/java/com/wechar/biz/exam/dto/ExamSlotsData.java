package com.wechar.biz.exam.dto;

import java.util.List;

/** 某检查项目的未来排期；available=false 时客户端置灰不可选。 */
public record ExamSlotsData(String itemCode, String itemName, List<ExamSlotData> slots) {

    public record ExamSlotData(String slotKey, String slotDate, String slotTime, boolean available) {
    }
}
