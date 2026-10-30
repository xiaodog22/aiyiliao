package com.wechar.biz.voice.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/** 契约 Voice（第三方音色可能随时失效：available=false 时界面回退默认音色）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record VoiceData(String id, String displayName, String locale, String gender,
                        Boolean isDefault, Boolean isCustom, Boolean available) {
}
