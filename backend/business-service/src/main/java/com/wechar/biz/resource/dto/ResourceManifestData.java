package com.wechar.biz.resource.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * 契约 ResourceManifest（manifestVersion + items 必填；item 必填 key/level/mime/size/sha256，
 * level 枚举 A|B，additionalProperties 未禁用——仅下发契约属性）。
 * 契约红线：清单禁止下发可执行 JS/WXML 或未签名的安全规则（如红旗词表）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record ResourceManifestData(
        String manifestVersion,
        Instant generatedAt,
        List<Item> items
) {
    public record Item(
            String key,
            String level,
            String mime,
            long size,
            String sha256,
            String url,
            String version,
            Instant expiresAt,
            String fallbackKey
    ) {
    }
}
