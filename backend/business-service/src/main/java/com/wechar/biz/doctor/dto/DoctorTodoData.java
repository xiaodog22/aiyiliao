package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 DoctorTodo（N3，2026-10-19）：医生待处理事项。
 * id/kind/title 必填；subtitle/count/route/createdAt 可选（null 自动省略）。
 * kind 枚举：CONSULT_REPLY · CHECKIN_CONFIRM · REPORT_REVIEW。
 * route 由服务端下发（客户端不得自行拼业务路径）；null = 该项不可点击。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorTodoData(String id, String kind, String title, String subtitle,
                             Integer count, String route, Instant createdAt) {
}
