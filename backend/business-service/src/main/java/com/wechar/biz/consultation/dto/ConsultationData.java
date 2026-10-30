package com.wechar.biz.consultation.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 Consultation（列表只给元数据与摘要，不含完整正文）。
 *
 * V21（2026-10-21）：补齐契约 §Consultation 2026-10-19 已声明、Java 未实现的医生卡字段
 * （在线问诊页效果图 04，遗留清单第 18 页 #1）：
 *  - doctorName/doctorTitle/departmentName：来自 consultations.doctor_id → doctors/departments 关联；
 *    未分配医生 → 三项 null（客户端显示「待接诊」，不编造医生信息）；
 *  - accepting：是否接诊中。服务端可判定口径 = 已分配医生且末条消息非患者发言 → true；
 *    末条为患者发言 → false；未分配医生 → null（未知）。null 时客户端显示「待接诊」，
 *    不得把未知当成「接诊中」；
 *  - version：预留（契约可选，当前无并发写场景，恒 null 省略）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ConsultationData(String id, String title, String status, Instant lastMessageAt,
                               Integer messageCount, String summary, Instant createdAt,
                               String doctorName, String doctorTitle, String departmentName,
                               Boolean accepting, String version) {
}
