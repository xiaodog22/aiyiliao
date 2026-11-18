package com.wechar.biz.common;

/**
 * LIKE 通配符转义（审计 L11）。
 *
 * <p>问题：搜索关键词直接拼进 {@code "%" + kw + "%"}，患者/运营传 {@code %} 或 {@code _}
 * 会被数据库当成通配符 —— {@code %} 等于强制全表模糊扫描（DoS），也是"绕过关键词过滤做信息枚举"
 * 的入口。参数化只防注入，不防通配符语义。</p>
 *
 * <p>口径：用 {@code !} 作转义符（而不是默认的反斜杠），SQL 侧显式写 {@code ESCAPE '!'}，
 * 避免 Java 字符串与 MySQL/H2 反斜杠语义差异带来的"看起来转了、实际没转"。</p>
 */
public final class SqlLike {

    /** 转义符（与 SQL 里的 ESCAPE '!' 必须一致）。 */
    public static final String ESCAPE_CLAUSE = " ESCAPE '!'";

    private SqlLike() {
    }

    /** 生成"包含"匹配串：{@code %kw%}，其中 kw 内的 {@code ! % _} 已转义为字面量。 */
    public static String contains(String keyword) {
        if (keyword == null) {
            return "%";
        }
        return "%" + escape(keyword) + "%";
    }

    /** 转义 LIKE 元字符：`!` 必须最先替换（否则会把后续插入的转义符再转一次）。 */
    public static String escape(String keyword) {
        return keyword
                .replace("!", "!!")
                .replace("%", "!%")
                .replace("_", "!_");
    }
}
