package com.wechar.biz.common;

import java.time.Instant;

/**
 * 时间约定（docs/v4/03 §5）：写库 DATETIME(3) 一律 UTC；响应一律 ISO-8601 UTC（Z 结尾）。
 * JdbcApi 统一把 java.sql.Timestamp 按 UTC 读取（jdbcUrl 已带 connectionTimeZone=UTC）。
 * 本类只负责"当前时刻"这一权威时间源，便于测试替换。
 */
public final class Utc {

    private Utc() {
    }

    /** 当前 UTC 时刻（Instant 即 Z 结尾 ISO-8601，Jackson 默认序列化为带 Z 的格式）。 */
    public static Instant now() {
        return Instant.now();
    }
}
