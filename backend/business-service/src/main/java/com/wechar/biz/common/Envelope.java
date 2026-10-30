package com.wechar.biz.common;

import java.time.Instant;

/**
 * 统一成功信封（契约 EnvelopeBase：code/message/requestId/serverTime 必填，data/meta 可选）。
 * code 成功固定为 OK。
 */
public record Envelope<T>(String code, String message, String requestId, Instant serverTime, T data, Object meta) {

    public static <T> Envelope<T> ok(String requestId, T data) {
        return new Envelope<>("OK", "成功", requestId, Instant.now(), data, null);
    }

    /** 带 meta（契约 ApiMeta：nextCursor/total 等分页信息）的成功信封。 */
    public static <T> Envelope<T> ok(String requestId, T data, Object meta) {
        return new Envelope<>("OK", "成功", requestId, Instant.now(), data, meta);
    }
}
