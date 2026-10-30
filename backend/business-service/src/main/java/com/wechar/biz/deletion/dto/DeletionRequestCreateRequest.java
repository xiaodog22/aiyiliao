package com.wechar.biz.deletion.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import java.util.List;

/**
 * 契约 DeletionRequestCreate：required=[scope]（minItems 1，枚举 6 值）、reason ≤200。
 * 契约声明 additionalProperties:false → 保持严格（未知字段 → 400）。
 * 契约该路径**未声明 422**（只有 400/401/409）→ 取值校验在服务层按 400 返回，不臆造状态码。
 */
@JsonIgnoreProperties(ignoreUnknown = false)
public record DeletionRequestCreateRequest(List<String> scope, String reason) {
}
