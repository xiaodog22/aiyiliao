package com.wechar.biz.user.dto;

import com.fasterxml.jackson.annotation.JsonInclude;

/**
 * GET /me 的聚合对象：身份 + 档案 + 偏好 + 手机脱敏字段。
 * 任务书列的 OkMe/UserProfile/UserPreferences 未在契约 components 中出现，字段按契约
 * User/UserPreferences 语义与 V1/V2 表结构对齐；契约 User 对象本身 additionalProperties:false
 * 不接受扩展，故这些字段只出现在 /me 自有 data 层。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MeData(
        UserData user,
        ProfileData profile,
        PreferencesData preferences,
        String phoneCipher,
        String phoneLast4,
        Boolean phoneBound
) {
}
