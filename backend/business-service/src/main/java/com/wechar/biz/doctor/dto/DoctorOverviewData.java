package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 DoctorOverview（N18，2026-10-19）：工作台/挂号页统计骨架。
 * Integer 可空：子块独立降级失败 → null（前端不渲染该卡，不用 0 冒充）；
 * inProgress 恒为 null —— 状态机无「接诊中」状态，服务端不可判定（见契约 description）。
 * 显式保留 null 字段（不加 NON_NULL），让"不可判定"以 null 显式下发而非省略。
 */
@JsonInclude(JsonInclude.Include.ALWAYS)
public record DoctorOverviewData(Integer waiting, Integer inProgress, Integer done,
                                 Integer todayTotal, Integer pendingTodos) {
}
