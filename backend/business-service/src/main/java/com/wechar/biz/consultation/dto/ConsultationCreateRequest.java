package com.wechar.biz.consultation.dto;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

/**
 * 契约 ConsultationCreate（additionalProperties:false 由全局严格反序列化保证）。
 * initialMessage 属敏感健康信息，不进入埋点/日志正文。
 *
 * V23（2026-10-24）：doctorId 可选 —— 患者「挂号完成 → 在线问诊 → 选择医生」申请模式：
 *  - 传 doctorId：会话直接分配该医生（无需认领），并向医生登录账号写 CONSULT_APPLY 消息；
 *  - 不传：进认领池（AI 咨询 / 医生端接诊）。
 */
public record ConsultationCreateRequest(
        @NotBlank(message = "initialMessage 不能为空") @Size(max = 2000) String initialMessage,
        @Size(max = 10) String inputMode,
        @Size(max = 20) String requestedProfile,
        @Size(max = 20) String locale,
        @Size(max = 64) String doctorId) {
}
