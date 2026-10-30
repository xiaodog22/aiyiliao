package com.wechar.biz.common;

import java.util.UUID;
import org.slf4j.MDC;

/**
 * requestId 逻辑：优先回显客户端 X-Request-Id（契约 RequestId 参数），否则服务端生成。
 * 通过 MDC 贯穿日志，通过请求属性贯穿响应。
 */
public final class RequestIds {

    public static final String MDC_KEY = "requestId";
    public static final String HEADER = "X-Request-Id";

    private RequestIds() {
    }

    /** 生成一个合法的 requestId：有值则回显（8~64 字符），无值则生成 UUID。 */
    public static String normalize(String clientProvided) {
        if (clientProvided != null) {
            String trimmed = clientProvided.trim();
            if (trimmed.length() >= 8 && trimmed.length() <= 64) {
                return trimmed;
            }
        }
        return UUID.randomUUID().toString();
    }

    /** 当前请求的 requestId（由 {@link RequestIdFilter} 写入 MDC）；无请求上下文时返回生成值。 */
    public static String current() {
        String id = MDC.get(MDC_KEY);
        return id != null ? id : UUID.randomUUID().toString();
    }
}
