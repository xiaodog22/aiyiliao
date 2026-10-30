package com.wechar.biz.doctor.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

/**
 * 契约 updateAppointmentStatus 请求体：
 * required=[toStatus, expectedVersion]；note ≤200。
 * 契约该 body 未声明 additionalProperties:false → 宽容未知字段（避免 Spring 全局严格反序列化误拒）。
 * 取值校验（枚举/状态机）在服务层做：本路径契约声明 422 → 未知枚举按 422 返回。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
public record AppointmentStatusUpdateRequest(
        @NotBlank String toStatus,
        @NotNull @Min(1) Integer expectedVersion,
        @Size(max = 200) String note) {
}
