package com.wechar.biz.voice.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 TtsResult：不内联音频字节，只给短期签名 URL；命中缓存同样返回 URL 并置 cached=true。
 * engine 只是适配器标识——客户端不得据此宣称任何 SLA，也不得描述成 Azure 正式商业服务。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record TtsResultData(String audioUrl, String mime, Integer durationMs, Boolean cached,
                            String engine, String voiceId, Boolean degraded) {
}
