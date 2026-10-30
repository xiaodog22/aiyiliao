package com.wechar.biz.common;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import org.springframework.http.HttpStatus;

/**
 * 契约游标（Cursor ≤256 字符）编解码：opaque 形式的 "created_at 毫秒-id"，
 * 客户端只透传不解码；解码失败按契约 422 VALIDATION_FAILED 处理（不给内部细节）。
 */
public final class Cursors {

    private Cursors() {
    }

    /** 编码游标（新→旧或旧→新列表均用 (createdAt, id) 定位）。 */
    public static String encode(Instant createdAt, String id) {
        String raw = createdAt.toEpochMilli() + "-" + id;
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(raw.getBytes(StandardCharsets.UTF_8));
    }

    /** 解码游标；非法 → 422。 */
    public static PageCursor decode(String cursor) {
        try {
            String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            int split = raw.indexOf('-');
            if (split <= 0) {
                throw new IllegalArgumentException("缺少分隔符");
            }
            return new PageCursor(Instant.ofEpochMilli(Long.parseLong(raw.substring(0, split))),
                    raw.substring(split + 1));
        } catch (RuntimeException e) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "cursor 非法或已过期，请从首页重新拉取");
        }
    }

    /** 游标载荷：定位点 (createdAt, id)。 */
    public record PageCursor(Instant createdAt, String id) {
    }

    /** 契约 ApiMeta（nextCursor/total/version 可选）。 */
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record ApiMeta(String nextCursor, Integer total, String version) {
    }
}
