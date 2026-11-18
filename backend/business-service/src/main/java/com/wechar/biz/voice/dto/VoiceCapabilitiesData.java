package com.wechar.biz.voice.dto;

import java.util.Map;

/**
 * 前端降级开关快照（2026-11-18）。
 * degradeMode: full（全链路）/ local（仅本地）。
 * switches: llm/asr/tts/rag/deepseek/edge/wechatSi/asrCloud，值即最终生效结果（已乘总开关）。
 * 探针不可达时由业务侧 fail-closed 为 local + 全部 false，前端不得据此放行云端兜底。
 */
public record VoiceCapabilitiesData(String degradeMode, Map<String, Boolean> switches) {
}
