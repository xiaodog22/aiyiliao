package com.wechar.biz.message.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;

/**
 * 契约 MessageCenterItem（V21 消息中心，additionalProperties:false）。
 * read：由 read_at 是否为空派生（不下发内部时间戳）。
 * refType/refId：关联业务对象（appointment/consultation/null），供客户端跳转；
 *   客户端只能跳服务端给出的对象，不得自行构造路径。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record MessageData(
        String id,
        String type,
        String title,
        String body,
        String refType,
        String refId,
        boolean read,
        Instant createdAt
) {
}
