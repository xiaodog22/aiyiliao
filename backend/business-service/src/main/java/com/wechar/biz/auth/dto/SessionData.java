package com.wechar.biz.auth.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.wechar.biz.user.dto.UserData;

/**
 * 契约 Session（additionalProperties 不禁止，但本对象严格按契约五字段下发）：
 * accessToken（短期，仅响应体）/ refreshToken（一次一换，服务端只存哈希）/
 * expiresIn（≥60 秒）/ tokenType（恒为 Bearer）/ user（User schema）。
 * 手机绑定状态走 user.phoneBound，不再附加会话级字段。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record SessionData(
        String accessToken,
        String refreshToken,
        int expiresIn,
        String tokenType,
        UserData user
) {
}
