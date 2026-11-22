package com.wechar.biz.triage;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.stereotype.Component;

/**
 * 急症红旗规则引擎（确定性、无生成、无网络）。
 *
 * <p>词表事实源（2026-11-22 敌意审查 L1/L12 整改）：
 * 不再手写在 Java 里，统一由 {@code miniprogram/utils/triage-red-flags.js}
 * 经 {@code tools/gen-triage-flags.js} 生成 {@link RedFlagRules}。
 * 前端 15 类红旗与服务端 15 类同源、同 id、同 any/all/none 语义；
 * 生成物漂移由 {@code node tools/gen-triage-flags.js --check} 在 CI 拦截。
 *
 * <p>规则事实：
 *  - 服务端**不得降低**客户端 localRuleHits 的等级：只要命中即 EMERGENCY；
 *  - 症状文本关键词匹配急症红旗词表（any 任一 / all 至少一个 / none 排除）；
 *  - 规则集版本 TRIAGE-RULES-001 可配置化；
 *  - 科室映射只落到真实 departments 表数据（消化/呼吸/心血管/骨科）。
 * provenance 恒为 RULE_RESULT（规则结果，不得伪装成 AI）。
 */
@Component
public class TriageRuleEngine {

    public static final String RULESET_VERSION = "TRIAGE-RULES-001";

    public static final String LIMITATIONS =
            "本结果仅基于症状关键词的分诊参考，不构成诊断；症状持续、加重或出现急症表现时请立即就医或拨打 120。";

    /** 关键词 → 科室名映射（展示用；departmentId 需查 departments 表后填充）。 */
    private static final Map<String, List<String>> DEPARTMENT_KEYWORDS = new LinkedHashMap<>();

    static {
        DEPARTMENT_KEYWORDS.put("消化内科", List.of("胃", "腹痛", "腹泻", "反酸", "烧心", "恶心", "呕吐", "便秘", "消化"));
        DEPARTMENT_KEYWORDS.put("呼吸内科", List.of("咳嗽", "咳痰", "咽痛", "鼻塞", "流涕", "气喘", "感冒", "发热", "呼吸困难"));
        DEPARTMENT_KEYWORDS.put("心血管内科", List.of("心慌", "心悸", "头晕", "血压", "胸闷", "高血压"));
        DEPARTMENT_KEYWORDS.put("骨科", List.of("腰痛", "腰疼", "关节", "骨折", "颈肩", "扭伤", "膝盖", "腿疼"));
    }

    /** 客户端本地命中项的严重级别：非空即视为急症（不降级规则的默认最高级）。 */
    public static final String EMERGENCY_LEVEL = "EMERGENCY";

    /**
     * 规则 ID → 用户可读名称（由生成词表构建，禁止再手写第二份标签）。
     *
     * ⚠️ 对外文案只能用这张表里的中文：原实现把 chest_pain / dyspnea 这类内部规则码
     *    直接拼进急症弹窗（"命中急症红旗：chest_pain"），患者看不懂，也泄漏了实现细节。
     */
    private static final Map<String, String> RULE_LABELS;

    static {
        Map<String, String> labels = new LinkedHashMap<>();
        for (RedFlagRules.Rule rule : RedFlagRules.ALL) {
            labels.put(rule.id(), rule.label());
        }
        RULE_LABELS = Map.copyOf(labels);
    }

    /**
     * 该位置的关键词是否被前置否定词否决（B1：与前端 isNegated 同构）。
     *
     * 只在「关键词前 {@link RedFlagRules.Negation#WINDOW} 个字」的小窗口内判定，并且：
     *  ① 遇到转折词就重新起算——"没有发烧但胸痛"不能因为前面有"没有"就吞掉胸痛；
     *  ② 否定词与关键词之间最多隔 {@link RedFlagRules.Negation#MAX_GAP} 个字；
     *  ③ 「无/没/没有 + 诱因|原因」修饰的是诱因（无诱因胸痛 = 无明确诱因的胸痛），
     *     属阳性主诉，不得当成否认症状；
     *  ④ 弱否定「不」只认紧邻或隔一个程度词，避免吞掉「不舒服3天」的时长。
     * 宁可漏判否定，也不误吞阳性：吞掉真阳性比多报一次更危险。
     */
    private static boolean denied(String text, int idx) {
        int from = Math.max(0, idx - RedFlagRules.Negation.WINDOW);
        String pre = text.substring(from, idx);
        int cut = 0;
        for (String c : RedFlagRules.Negation.CONTRASTS) {
            int i = pre.lastIndexOf(c);
            if (i >= 0) {
                cut = Math.max(cut, i + c.length());
            }
        }
        String win = pre.substring(cut);
        for (String n : RedFlagRules.Negation.WORDS) {
            int i = win.lastIndexOf(n);
            if (i < 0) {
                continue;
            }
            String gapText = win.substring(i + n.length());
            if (gapText.length() > RedFlagRules.Negation.MAX_GAP) {
                continue;
            }
            if (RedFlagRules.Negation.TRIGGER_NOUNS.contains(gapText)) {
                continue; // 无诱因 / 无原因：症状阳性，不是否认
            }
            return true;
        }
        int weakFrom = Math.max(0, idx - RedFlagRules.Negation.WEAK_SPAN);
        return WEAK_TAIL.matcher(text.substring(weakFrom, idx)).find();
    }

    /** 弱否定「不」的紧邻正则（由 shared 规格生成，禁止手写第二份）。 */
    private static final Pattern WEAK_TAIL =
            Pattern.compile(RedFlagRules.Negation.WEAK_TAIL_REGEX);

    /** 把规则 ID 列表翻成中文名称（对外文案用）。 */
    public static String describe(List<String> ruleIds) {
        if (ruleIds == null || ruleIds.isEmpty()) {
            return "";
        }
        List<String> labels = new ArrayList<>();
        for (String id : ruleIds) {
            labels.add(RULE_LABELS.getOrDefault(id, "危险信号"));
        }
        return String.join("、", labels);
    }

    public record RuleOutcome(boolean emergency, String level, List<String> matchedRules, String advice) {
    }

    /**
     * 文本红旗扫描（确定性）。**先归一、后匹配**（08F §3.1）。
     *
     * <p>与前端 {@code triage-engine.js matchRedFlags} 同构：
     * <ol>
     *   <li>any 任一阳性关键词命中；</li>
     *   <li>all 非空时，还需其中**至少一个**命中（前端语义是 anyHit(all)，不是全部）；</li>
     *   <li>none 出现即排除（当前词表为空，保留语义防未来误报）。</li>
     * </ol>
     * ⚠️ 漏一个急症比多报一次严重：宁可多报，不可漏报；否定只在明确前置窗口生效。
     */
    public RuleOutcome scanText(String text) {
        String t = TriageNormalizer.normalize(text);
        List<String> matched = new ArrayList<>();
        for (RedFlagRules.Rule rule : RedFlagRules.ALL) {
            if (!hitsAny(t, rule.any())) {
                continue;
            }
            if (!rule.all().isEmpty() && !hitsAny(t, rule.all())) {
                continue;
            }
            boolean excluded = false;
            for (String banned : rule.none()) {
                if (!banned.isEmpty() && t.contains(banned)) {
                    excluded = true;
                    break;
                }
            }
            if (!excluded) {
                matched.add(rule.id());
            }
        }
        if (matched.isEmpty()) {
            return new RuleOutcome(false, "INFO", List.of(), null);
        }
        return new RuleOutcome(true, EMERGENCY_LEVEL, matched, emergencyAdvice());
    }

    /**
     * 关键词列表中是否有**未被否定**的出现位置。
     *
     * <p>逐个出现位置判否定：同一段话里"没有胸痛……后来胸痛加重"仍要命中；
     * 不能因为第一次出现被否定就跳过整条规则。
     */
    private static boolean hitsAny(String text, List<String> keywords) {
        for (String keyword : keywords) {
            if (keyword == null || keyword.isEmpty()) {
                continue;
            }
            int idx = text.indexOf(keyword);
            while (idx >= 0 && denied(text, idx)) {
                idx = text.indexOf(keyword, idx + keyword.length());
            }
            if (idx >= 0) {
                return true;
            }
        }
        return false;
    }

    /**
     * 合并客户端 localRuleHits：**只要非空 → emergency=true / level=EMERGENCY**（不降级）。
     * 规则级联（服务端文本扫描）也并入，取最高级。
     */
    public RuleOutcome evaluate(List<String> localRuleHits, String symptoms) {
        Set<String> matched = new LinkedHashSet<>();
        if (localRuleHits != null) {
            localRuleHits.stream().filter(h -> h != null && !h.isBlank()).forEach(matched::add);
        }
        RuleOutcome text = scanText(symptoms);
        matched.addAll(text.matchedRules());
        boolean emergency = !matched.isEmpty();
        return new RuleOutcome(emergency, emergency ? EMERGENCY_LEVEL : "INFO",
                List.copyOf(matched), emergency ? emergencyAdvice() : null);
    }

    /** 科室推荐：按关键词命中数排序，映射到真实 departments 数据。 */
    public record DeptHit(String departmentName, int hits, List<String> matchedKeywords) {
    }

    public List<DeptHit> recommendDepartments(String symptoms) {
        String t = TriageNormalizer.normalize(symptoms);
        List<DeptHit> hits = new ArrayList<>();
        for (var entry : DEPARTMENT_KEYWORDS.entrySet()) {
            List<String> matched = entry.getValue().stream().filter(t::contains).toList();
            if (!matched.isEmpty()) {
                hits.add(new DeptHit(entry.getKey(), matched.size(), matched));
            }
        }
        hits.sort((a, b) -> Integer.compare(b.hits(), a.hits()));
        return hits;
    }

    public static String emergencyAdvice() {
        return "疑似急症表现：请立即拨打 120 或前往最近医院急诊科，不要等待线上回复。";
    }

    public static String normalGuidance() {
        return "建议携带症状记录尽快线下就诊；若症状加重或出现胸痛、呼吸困难、意识异常等情况，请立即就医。";
    }
}
