package com.wechar.biz.bed.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 契约 BedAssignmentRequest：required=[action, expectedVersion]；
 * patientRef（ASSIGN 时必填，使用内部患者 ID，不接受姓名或手机号）、note ≤200。
 * 契约该 body 未声明 additionalProperties:false → 宽容未知字段。
 * action 取值校验在服务层（契约该路径声明 422）。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record BedAssignmentRequest(
        @NotBlank String action,
        String patientRef,
        @NotNull @Min(1) Integer expectedVersion,
        @Size(max = 200) String note) {
}
