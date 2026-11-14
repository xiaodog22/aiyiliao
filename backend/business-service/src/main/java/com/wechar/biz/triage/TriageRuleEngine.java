package com.wechar.biz.triage;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.stereotype.Component;

/**
 * 急症红旗规则引擎（确定性、无生成、无网络）。
 * 规则事实（O-07 占位，待医学审核）：
 *  - 服务端**不得降低**客户端 localRuleHits 的等级：只要命中即 EMERGENCY；
 *  - 症状文本关键词匹配急症红旗词表（胸痛/呼吸困难/意识/咯血/昏迷等）；
 *  - 规则集版本 TRIAGE-RULES-001 可配置化；
 *  - 科室映射只落到真实 departments 表数据（消化/呼吸/心血管/骨科）。
 * provenance 恒为 RULE_RESULT（规则结果，不得伪装成 AI）。
 */
@Component
public class TriageRuleEngine {

    public static final String RULESET_VERSION = "TRIAGE-RULES-001";

    public static final String LIMITATIONS =
            "本结果仅基于症状关键词的分诊参考，不构成诊断；症状持续、加重或出现急症表现时请立即就医或拨打 120。";

    /** 急症红旗词表：ruleId → 关键词列表（任一命中即命中该规则）。 */
    private static final Map<String, List<String>> RED_FLAGS = new LinkedHashMap<>();

    static {
        RED_FLAGS.put("chest_pain", List.of("胸痛", "心口疼", "胸口压", "压榨样"));
        RED_FLAGS.put("dyspnea", List.of("呼吸困难", "喘不上气", "憋气", "气短加重", "窒息"));
        RED_FLAGS.put("consciousness", List.of("意识模糊", "晕厥", "昏厥", "叫不醒", "意识丧失"));
        RED_FLAGS.put("hemoptysis", List.of("咯血", "咳血"));
        RED_FLAGS.put("coma", List.of("昏迷", "不省人事"));
        // 便血/黑便：与前端 miniprogram/utils/triage-kb.js 危险信号表对齐（08F §3.2：
        // 「肚子疼得厉害 + 便血」归一后红旗仍须触发——原表缺失，服务端会漏判下消化道出血）。
        RED_FLAGS.put("severe_bleeding", List.of("大出血", "呕血", "喷射状", "便血", "黑便"));
        RED_FLAGS.put("stroke_signs", List.of("口角歪斜", "言语不清", "一侧肢体无力", "偏瘫"));
    }

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
     * 规则 ID → 用户可读名称。
     *
     * ⚠️ 对外文案只能用这张表里的中文：原实现把 chest_pain / dyspnea 这类内部规则码
     *    直接拼进急症弹窗（"命中急症红旗：chest_pain"），患者看不懂，也泄漏了实现细节。
     */
    private static final Map<String, String> RULE_LABELS = Map.of(
            "chest_pain", "急性胸痛",
            "dyspnea", "呼吸困难",
            "consciousness", "意识障碍",
            "hemoptysis", "咯血",
            "coma", "昏迷",
            "severe_bleeding", "活动性出血",
            "stroke_signs", "疑似卒中表现");

    /** 否定词：出现在红旗词之前的小窗口内，视为患者明确否认该症状。 */
    private static final List<String> NEGATIONS =
            List.of("没有", "没", "无", "否认", "不是", "未见", "未出现", "没出现", "不伴", "不伴有", "无伴");

    /** 转折词：其后出现的关键词不受前面的否定词约束（"没有发烧但胸痛" 的胸痛仍算阳性）。 */
    private static final List<String> CONTRASTS = List.of("但", "不过", "却", "而是", "后来", "随后");

    /** 否定词与关键词之间允许的最大间隔字数（"没有明显胸痛""无任何胸痛"）。 */
    private static final int NEGATION_GAP = 2;

    /**
     * 该位置的关键词是否被前置否定词否决。
     *
     * 只在「关键词前 6 个字」的小窗口内判定，并且：
     *  ① 遇到转折词就重新起算——"没有发烧但胸痛"不能因为前面有"没有"就吞掉胸痛；
     *  ② 否定词与关键词之间最多隔 2 个字——"胸痛不适伴胸闷"里的"不"不会误伤"胸闷"。
     * 宁可漏判否定，也不误吞阳性：吞掉真阳性比多报一次更危险。
     */
    private static boolean denied(String text, int idx) {
        int from = Math.max(0, idx - 6);
        String pre = text.substring(from, idx);
        int cut = 0;
        for (String c : CONTRASTS) {
            int i = pre.lastIndexOf(c);
            if (i >= 0) {
                cut = Math.max(cut, i + c.length());
            }
        }
        String win = pre.substring(cut);
        for (String n : NEGATIONS) {
            int i = win.lastIndexOf(n);
            if (i >= 0 && win.length() - (i + n.length()) <= NEGATION_GAP) {
                return true;
            }
        }
        return false;
    }

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

    /** 文本红旗扫描（确定性）。**先归一、后匹配**（08F §3.1）。 */
    public RuleOutcome scanText(String text) {
        String t = TriageNormalizer.normalize(text);
        List<String> matched = new ArrayList<>();
        for (var entry : RED_FLAGS.entrySet()) {
            for (String keyword : entry.getValue()) {
                // 逐个出现位置判否定：同一段话里"没有胸痛……后来胸痛加重"仍要命中。
                int idx = t.indexOf(keyword);
                while (idx >= 0 && denied(t, idx)) {
                    idx = t.indexOf(keyword, idx + keyword.length());
                }
                if (idx >= 0) {
                    matched.add(entry.getKey());
                    break;
                }
            }
        }
        if (matched.isEmpty()) {
            return new RuleOutcome(false, "INFO", List.of(), null);
        }
        return new RuleOutcome(true, EMERGENCY_LEVEL, matched, emergencyAdvice());
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
        return "疑似急症表现：请立即拨打 120 或前往最近急诊就诊，不要等待线上回复。";
    }

    public static String normalGuidance() {
        return "建议携带症状记录尽快线下就诊；若症状加重或出现胸痛、呼吸困难、意识异常等情况，请立即就医。";
    }
}
