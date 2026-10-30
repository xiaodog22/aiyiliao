package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Size;
import java.math.BigDecimal;

/** PUT /api/v1/me/preferences 请求（任务书 PreferencesUpdateRequest；整体覆盖提供的字段；契约外补充路径宽松收未知字段，见 JacksonStrictConfig）。 */
@com.fasterxml.jackson.annotation.JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record PreferencesUpdateRequest(
        @Size(max = 20) String locale,
        @Size(max = 16) String themeMode,
        @Size(max = 16) String fontScale,
        @DecimalMin("0.5") @DecimalMax("2.0") BigDecimal ttsRate,
        Boolean ttsAutoPlay,
        Integer version
) {
}
