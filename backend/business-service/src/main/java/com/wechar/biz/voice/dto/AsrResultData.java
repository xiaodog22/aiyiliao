package com.wechar.biz.voice.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * 契约 AsrResult：requiresConfirmation 固定为 true（转写必须经用户核对才能进入诊疗流程）。
 * language 为模型真实给出的标记，模型不提供时为 null（不猜测）；hasTimestamps=false 时界面不得显示时间轴。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record AsrResultData(String text, String language, Integer durationMs, String modelId,
                            String modelVersion, Boolean hasTimestamps, Boolean requiresConfirmation,
                            Boolean cached) {
}
