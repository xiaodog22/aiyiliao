package com.wechar.biz.patient.dto;

/**
 * 契约 InterpretationRequest（N2，2026-10-19）：报告 AI 解读请求。
 * scope 缺省/空 → 服务端默认 SUMMARY；仅支持 SUMMARY/DETAIL，其余 → 422（不静默降级）。
 */
public record InterpretationRequest(String scope) {
}
