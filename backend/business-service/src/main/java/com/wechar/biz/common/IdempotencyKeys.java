package com.wechar.biz.common;

import org.springframework.http.HttpStatus;

/**
 * 幂等键工具（契约通用约定：写操作要求 Idempotency-Key；相同键不同载荷返回 409）。
 */
public final class IdempotencyKeys {

    public static final String HEADER = "Idempotency-Key";
    /** 重放标记头：同键同载荷返回原资源时置 true（任务书 M1 规则 4）。 */
    public static final String REPLAY_HEADER = "Idempotency-Replayed";

    private IdempotencyKeys() {
    }

    /** 必填校验：缺失/空白 → 400 MISSING_IDEMPOTENCY_KEY；长度超限 → 400。 */
    public static String require(String key) {
        if (key == null || key.isBlank()) {
            throw new ApiException("MISSING_IDEMPOTENCY_KEY", HttpStatus.BAD_REQUEST,
                    "缺少必需请求头 Idempotency-Key；重试必须复用同一键");
        }
        String trimmed = key.trim();
        if (trimmed.length() < 8 || trimmed.length() > 128) {
            throw new ApiException("INVALID_IDEMPOTENCY_KEY", HttpStatus.BAD_REQUEST,
                    "Idempotency-Key 长度须为 8~128 字符");
        }
        return trimmed;
    }
}
