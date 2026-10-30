package com.wechar.biz.appointment.dto;

/** 任务书 AppointmentStats：upcoming/completed/cancelled 三计数（COMPLETED 单独计数）。 */
public record AppointmentStatsData(int upcoming, int completed, int cancelled) {
}
