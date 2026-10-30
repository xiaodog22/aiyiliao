package com.wechar.biz.voice.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 VoiceModel：能力状态而非承诺（权重缺失如实反映 unavailable，客户端据此禁用入口）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record VoiceModelData(String modelId, String capability, String status, String detail) {
}
