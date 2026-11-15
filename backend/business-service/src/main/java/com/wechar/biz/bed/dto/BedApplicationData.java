package com.wechar.biz.bed.dto;

import java.time.Instant;

/**
 * 床位申请出参（申请制，2026-11-15）。
 *
 * status 枚举：PENDING（待护士站审批）/ APPROVED（已通过并落床）/ REJECTED（已驳回）/ CANCELLED（申请人撤销）。
 * patientDisplayName 与 beds.occupant_display_name 同口径：写入时已脱敏，出参不再二次加工。
 * bedLabel 可能为空（只申请病区、尚未排床）。
 */
public record BedApplicationData(
        String id,
        String doctorId,
        String doctorName,
        String departmentId,
        String wardId,
        String wardName,
        String bedId,
        String bedLabel,
        String patientDisplayName,
        String reason,
        String priority,
        String status,
        String reviewNote,
        Instant reviewedAt,
        Instant createdAt) {
}
