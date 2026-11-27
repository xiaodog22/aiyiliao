package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 PatientMapping（GET /api/v1/patients/{ref}/mapping）。
 *
 * 只暴露「关联进度」，不暴露 HIS 侧任何标识（无 MRN / patientId / 哈希）：
 * CONFLICT、ORPHAN 的细节一律不在本接口展开，读取报告时按 409/403 处理。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PatientMappingData(
        String linkState,
        String tier,
        boolean degraded,
        Instant decidedAt,
        Instant lastSyncedAt
) {
}
