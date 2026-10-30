package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 DoctorAvailability（V22）：患者侧只读——该医生当前是否可发起在线问诊。
 *
 * - online/accepting：来自 doctor_online_status（未开局 = 双 false，不臆造在线）；
 * - nextSlotAt：按周模板算出**下一次**出诊开始时间（本地墙上时间转 Instant）；
 *   模板为空或无未来时段 → null（客户端显示「暂无排班」，不要编造时间）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record DoctorAvailabilityData(String doctorId, boolean online, boolean accepting, Instant nextSlotAt) {
}
