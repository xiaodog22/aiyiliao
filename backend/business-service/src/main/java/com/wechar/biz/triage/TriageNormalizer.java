package com.wechar.biz.triage;

import java.util.Comparator;
import java.util.List;

/**
 * 口语 → 标准医学词归一化（08F T1；纯函数、无框架依赖）。
 *
 * 硬约束（08F §3，违反即判不通过）：
 *  1. **先归一、后匹配**：只做同义词替换，且替换结果仍须命中红旗词表——
 *     如「心口疼」→「胸痛」，chest_pain 红旗不丢；归一层绝不删除红旗词；
 *  2. **不做程度折叠**：「有点/很/非常/挺/比较」等程度副词原样保留，
 *     服务端只归一同义词、绝不归并严重度（前端 normalizeLoose 只用于打分，服务端同样不做）；
 *  3. **幂等**：normalize(normalize(x)) == normalize(x)——标准词不作为映射源，
 *     输出词集合与源词集合互不相交。
 *
 * 匹配按口语词长度降序（「喘不上气」先于「喘」），避免短词吃掉长词；
 * 裸「喘」替换前先保护「气喘/哮喘/喘息/喘鸣」等医学词，防止「哮喘」被破坏成
 * 「哮呼吸困难」（既丢呼吸内科关键词命中，又凭空造出红旗——过度分诊）。
 *
 * 归一化发生在关键词匹配与红旗判定**之前**（由 {@link TriageRuleEngine} 入口调用）。
 * 位置见 08F §1；不改规则权重与科室目录。
 */
public final class TriageNormalizer {

    /**
     * 口语/变体 → 标准词（08F §2 最小可用集；标准词均已在 DEPARTMENT_KEYWORDS 或红旗词表中）。
     * 源词均不等于目标词 → 幂等由构造保证。
     */
    private static final List<String[]> ENTRIES = List.of(
            // 腹部
            new String[] {"肚子难过", "腹痛"},
            new String[] {"肚子疼", "腹痛"},
            new String[] {"肚子痛", "腹痛"},
            new String[] {"拉肚子", "腹泻"},
            new String[] {"拉稀", "腹泻"},
            new String[] {"拉水", "腹泻"},
            new String[] {"拉不出", "便秘"},
            new String[] {"大便干", "便秘"},
            // 胃 / 反流（「烧心」本身已是标准词，仅口语变体心口烧入表）
            new String[] {"胃不舒服", "胃痛"},
            new String[] {"胃疼", "胃痛"},
            new String[] {"心口烧", "烧心"},
            // 恶心呕吐（目标词同时含「恶心」与「呕吐」，均在消化内科关键词中）
            new String[] {"想吐", "恶心呕吐"},
            new String[] {"要吐", "恶心呕吐"},
            new String[] {"反胃", "恶心呕吐"},
            // 头部（服务端 departments 无神经内科：归一保留标准词，不硬塞错科室）
            new String[] {"脑袋疼", "头痛"},
            new String[] {"头疼", "头痛"},
            // 胸部：「胸口闷/胸闷」是前端心血管症状词（非红旗）→ 归一为「胸闷」；
            // 「心口疼」本身是红旗词 chest_pain → 归一为「胸痛」，红旗触发不丢
            new String[] {"胸口闷", "胸闷"},
            new String[] {"心口疼", "胸痛"},
            // 呼吸（⚠️ 红旗相关 08F §2：目标词「呼吸困难」在 dyspnea 红旗表与呼吸内科关键词中；
            // 长短词按长度降序生效，「喘不过气/喘不上气」先于裸「喘」）
            new String[] {"喘不上气", "呼吸困难"},
            new String[] {"喘不过气", "呼吸困难"},
            new String[] {"气短", "呼吸困难"},
            new String[] {"喘", "呼吸困难"},
            // 发热
            new String[] {"低烧", "发热"},
            new String[] {"高烧", "发热"},
            new String[] {"发烧", "发热"}
    ).stream()
            // 按口语词长度降序：长词优先，防止「喘」吃掉「喘不上气」
            .sorted(Comparator.comparingInt((String[] p) -> p[0].length()).reversed())
            .toList();

    /** 须保护的医学词：含裸「喘」字但不得被替换（归一后原样还原）。 */
    private static final List<String> PROTECTED = List.of("气喘", "哮喘", "喘息", "喘鸣");

    /** 保护占位（PUA 区，实际用户输入不会出现）。 */
    private static final char SENTINEL = '\uE000';

    private TriageNormalizer() {
    }

    /** 归一化：保护医学词 → 逐条同义词替换（长度降序）→ 还原。null 安全；幂等。 */
    public static String normalize(String text) {
        String t = text == null ? "" : text;
        if (t.isEmpty()) {
            return t;
        }
        // 1) 保护含裸「喘」的医学词
        for (int i = 0; i < PROTECTED.size(); i++) {
            t = t.replace(PROTECTED.get(i), sentinel(i));
        }
        // 2) 同义词替换（含裸「喘」→「呼吸困难」）
        for (String[] pair : ENTRIES) {
            t = t.replace(pair[0], pair[1]);
        }
        // 3) 还原保护词
        for (int i = 0; i < PROTECTED.size(); i++) {
            t = t.replace(sentinel(i), PROTECTED.get(i));
        }
        return t;
    }

    private static String sentinel(int index) {
        return String.valueOf(SENTINEL) + (char) ('a' + index) + SENTINEL;
    }

    /** 映射表内容（供测试核验 08F §2 覆盖度；返回副本）。 */
    static List<String[]> entries() {
        return ENTRIES.stream().map(String[]::clone).toList();
    }
}
