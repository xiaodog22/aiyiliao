package com.wechar.biz.home.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.wechar.biz.appointment.dto.AppointmentData;
import com.wechar.biz.content.dto.ContentItemData;
import java.util.List;

/**
 * 契约 HomeSummary.blocks 元素（必填 kind/status）。
 * kind 枚举：NEXT_APPOINTMENT / HEALTH_TIPS / QUICK_SERVICES / CONTENT_FEED / CARE_PLAN；
 * status：ok / degraded / unavailable。某块 unavailable 时客户端隐藏该块（不显示空数据）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record HomeBlockData(String kind, String status, AppointmentData nextAppointment,
                            List<ContentItemData> contents, List<HomeServiceItem> services) {
}
