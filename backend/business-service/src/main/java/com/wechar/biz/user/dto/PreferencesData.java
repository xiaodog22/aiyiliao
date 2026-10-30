package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.math.BigDecimal;

/** PUT /me/preferences 的偏好对象（V2 user_preferences）。 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PreferencesData(
        String locale,
        String themeMode,
        String fontScale,
        BigDecimal ttsRate,
        Boolean ttsAutoPlay,
        Integer version
) {
}
