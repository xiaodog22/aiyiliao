package com.wechar.biz.triage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;

/**
 * 服务端分诊金标准评测门禁（2026-11-22 敌意审查 L1/L12 整改）。
 *
 * <p>背景：原 CI 只跑 {@code tools/eval-triage.js} 评测**前端**引擎，
 * 服务端 7 类词表没有任何评测，导致前端 15 类、服务端 7 类长期分裂，
 * 「误服农药 / 孕产出血 / 三月龄婴儿发热 / 自杀意念」等 8 类在在线问诊链路漏报。
 *
 * <p>本测试直接读取前端同一份 golden set（单一评测口径），对服务端引擎逐条断言：
 * <ul>
 *   <li>红旗召回 <b>必须 100%</b>（漏一个急症比答错十个科室严重）；</li>
 *   <li>每条样本命中期望的规则 id（id 已与前端统一）；</li>
 *   <li>否定窗口与 all 组合语义不得把真阳性吞掉，也不得把普通发热误报成婴儿急症。</li>
 * </ul>
 *
 * <p>路径：Maven surefire 的 working directory 是模块目录 {@code backend/business-service}，
 * golden 在仓库 {@code tools/data/}。找不到文件<b>直接失败</b>（门禁不得跳过）。
 */
class TriageRedFlagParityTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final TriageRuleEngine engine = new TriageRuleEngine();

    @Test
    void 规则集覆盖前端15类且id唯一() {
        List<RedFlagRules.Rule> rules = RedFlagRules.ALL;
        assertEquals(15, rules.size(), "服务端红旗类数必须与前端单一事实源一致（15 类）");
        Set<String> ids = new LinkedHashSet<>();
        for (RedFlagRules.Rule rule : rules) {
            assertTrue(ids.add(rule.id()), "规则 id 重复：" + rule.id());
            assertFalse(rule.any().isEmpty(), "规则缺少 any 关键词：" + rule.id());
            assertFalse(rule.label().isBlank(), "规则缺少中文标签：" + rule.id());
        }
        assertEquals(15, ids.size());
    }

    @Test
    void shared源与生成物逐类对齐_golden样本不得分叉() throws IOException {
        JsonNode source = MAPPER.readTree(Files.readString(sharedPath()));
        Set<String> sourceIds = new LinkedHashSet<>();
        source.path("rules").forEach((r) -> sourceIds.add(r.path("id").asText()));
        Set<String> generatedIds = new LinkedHashSet<>();
        RedFlagRules.ALL.forEach((r) -> generatedIds.add(r.id()));
        assertEquals(sourceIds, generatedIds,
                "服务端词表 id 必须与 shared/triage-redflags.json 逐类一致（缺一即失败）");
        assertEquals(15, sourceIds.size());

        JsonNode cases = source.path("cases");
        JsonNode golden = MAPPER.readTree(Files.readString(goldenPath())).path("redFlagCases");
        assertEquals(cases.size(), golden.size(), "golden 红旗样本数必须与 shared 源一致");
        for (int i = 0; i < cases.size(); i++) {
            String at = "第 " + (i + 1) + " 条：";
            assertEquals(cases.get(i).path("id").asText(), golden.get(i).path("id").asText(), at + "id 分叉");
            assertEquals(cases.get(i).path("text").asText(), golden.get(i).path("text").asText(), at + "text 分叉");
            assertEquals(cases.get(i).path("redFlag").asText(), golden.get(i).path("redFlag").asText(),
                    at + "redFlag 分叉");
        }
    }

    @Test
    void 负样本不得误报() throws IOException {
        JsonNode negatives = MAPPER.readTree(Files.readString(sharedPath())).path("negativeCases");
        assertTrue(negatives.size() >= 5, "负样本至少 5 条（防误报基线不得缩水）");
        List<String> failures = new java.util.ArrayList<>();
        for (JsonNode c : negatives) {
            String text = c.path("text").asText();
            TriageRuleEngine.RuleOutcome outcome = engine.scanText(text);
            if (outcome.emergency()) {
                failures.add(c.path("id").asText() + " 「" + text + "」被误报为 "
                        + outcome.matchedRules());
            }
        }
        assertTrue(failures.isEmpty(), "负样本误报：\n" + String.join("\n", failures));
    }

    @Test
    void golden红旗样本_服务端召回百分百() throws IOException {
        JsonNode data = MAPPER.readTree(Files.readString(goldenPath()));
        JsonNode cases = data.path("redFlagCases");
        assertTrue(cases.isArray() && cases.size() >= 29,
                "golden 红旗样本缺失（应含 20 条基线 + 9 条附录 A.1 急症漏报样本）");
        List<String> failures = new java.util.ArrayList<>();
        Set<String> coveredIds = new LinkedHashSet<>();
        for (JsonNode c : cases) {
            String text = c.path("text").asText();
            String expected = c.path("redFlag").asText();
            TriageRuleEngine.RuleOutcome outcome = engine.scanText(text);
            if (!outcome.emergency() || !outcome.matchedRules().contains(expected)) {
                failures.add(c.path("id").asText() + " 「" + text + "」期望=" + expected
                        + " 实际=" + outcome.matchedRules());
            }
            coveredIds.add(expected);
        }
        assertTrue(failures.isEmpty(), "服务端红旗漏报：\n" + String.join("\n", failures));

        // 15 类 id 必须全部被评测集覆盖：防止「删规则后样本仍全绿」的假通过。
        Set<String> allIds = new LinkedHashSet<>();
        RedFlagRules.ALL.forEach(r -> allIds.add(r.id()));
        assertEquals(allIds, coveredIds, "golden 未覆盖全部红旗 id，评测存在盲区");
    }

    @Test
    void 组合语义_all条件不满足不得误报() {
        // 普通发热 ≠ 三月龄婴儿发热；没有年龄证据绝不能触发 infant_fever。
        assertFalse(engine.scanText("发烧38度").emergency(), "普通发热被误报为婴儿急症");
        assertTrue(engine.scanText("三个月婴儿发烧38度").matchedRules().contains("infant_fever"));

        // 单纯出血 ≠ 孕产急症；没有怀孕证据不得触发 pregnancy_emergency。
        // 小伤口出血本身也不是活动性大出血红旗（与前端同口径，避免过度分诊）。
        assertFalse(engine.scanText("手划破了出血").emergency(), "无孕产证据的普通出血被误报");
        assertTrue(engine.scanText("怀孕八个月，下面出血").matchedRules().contains("pregnancy_emergency"));
    }

    @Test
    void 否定语义_明确否认不得触发() {
        assertFalse(engine.scanText("没有胸痛").emergency());
        assertFalse(engine.scanText("无胸痛，也没有呼吸困难").emergency());
        assertTrue(engine.scanText("没有胸痛，后来胸痛加重").emergency());
    }

    /**
     * B1 阻断项：否定词修饰的是「诱因/原因」，不是症状本身。
     * 「无诱因胸痛」是阳性主诉，服务端与前端都必须 HIT，不能当作否认吞掉。
     */
    @Test
    void 否定语义_无诱因无原因属阳性主诉() {
        List<String> positives = List.of(
                "无诱因胸痛，还冒冷汗", "无原因胸痛伴大汗", "没原因胸痛，出冷汗",
                "无明显诱因胸痛，冷汗直流", "无任何诱因胸痛、恶心");
        for (String text : positives) {
            TriageRuleEngine.RuleOutcome outcome = engine.scanText(text);
            assertTrue(outcome.emergency(), "阳性主诉被否定词吞掉：" + text);
            assertTrue(outcome.matchedRules().contains("chest_pain"), text + " 未命中 chest_pain");
        }
        assertFalse(engine.scanText("无胸痛").emergency());
        assertFalse(engine.scanText("没有胸痛").emergency());
        assertTrue(engine.scanText("无原因意识模糊").matchedRules().contains("consciousness"));
        assertTrue(engine.scanText("无诱因发热伴抽搐").matchedRules().contains("high_fever_convulsion"));
    }

    /**
     * 前后端差分基线（B1）：tools/data/triage-parity.json 是**前端引擎**对同一语料的
     * 实算结果；服务端逐条比对 emergency 与命中规则集合，任一不一致即失败。
     */
    @Test
    void 前后端差分基线_服务端逐条一致() throws IOException {
        JsonNode entries = MAPPER.readTree(Files.readString(parityPath())).path("entries");
        assertTrue(entries.isArray() && entries.size() >= 50,
                "差分基线缺失或语料不足（应覆盖 golden + 否定语料 + 负样本）");
        List<String> failures = new java.util.ArrayList<>();
        for (JsonNode entry : entries) {
            String text = entry.path("text").asText();
            boolean wantEmergency = entry.path("emergency").asBoolean();
            Set<String> wantRules = new java.util.TreeSet<>();
            entry.path("rules").forEach((r) -> wantRules.add(r.asText()));
            TriageRuleEngine.RuleOutcome outcome = engine.scanText(text);
            Set<String> gotRules = new java.util.TreeSet<>(outcome.matchedRules());
            if (outcome.emergency() != wantEmergency || !gotRules.equals(wantRules)) {
                failures.add(entry.path("id").asText() + " 「" + text + "」前端=(" + wantEmergency
                        + "," + wantRules + ") 服务端=(" + outcome.emergency() + "," + gotRules + ")");
            }
        }
        assertTrue(failures.isEmpty(), "前后端分诊结果不一致：\n" + String.join("\n", failures));
    }

    /** 定位 golden：模块目录 → 仓库根，克隆/IDE 两种工作目录都能跑；找不到即失败。 */
    private static Path goldenPath() {
        List<Path> candidates = List.of(
                Path.of("..", "..", "tools", "data", "triage-golden.json"),
                Path.of("..", "tools", "data", "triage-golden.json"),
                Path.of("tools", "data", "triage-golden.json"));
        for (Path p : candidates) {
            Path abs = p.toAbsolutePath().normalize();
            if (Files.isRegularFile(abs)) {
                return abs;
            }
        }
        throw new IllegalStateException("找不到 tools/data/triage-golden.json（从 "
                + Path.of(".").toAbsolutePath() + " 起算）；分诊门禁不得跳过");
    }

    /** 定位共享事实源：路径同上；找不到即失败（不允许退化成只测 Java 常量）。 */
    private static Path sharedPath() {
        List<Path> candidates = List.of(
                Path.of("..", "..", "shared", "triage-redflags.json"),
                Path.of("..", "shared", "triage-redflags.json"),
                Path.of("shared", "triage-redflags.json"));
        for (Path p : candidates) {
            Path abs = p.toAbsolutePath().normalize();
            if (Files.isRegularFile(abs)) {
                return abs;
            }
        }
        throw new IllegalStateException("找不到 shared/triage-redflags.json（从 "
                + Path.of(".").toAbsolutePath() + " 起算）；分诊门禁不得跳过");
    }

    /** 定位差分基线：找不到即失败（不允许退化成只测服务端自身）。 */
    private static Path parityPath() {
        List<Path> candidates = List.of(
                Path.of("..", "..", "tools", "data", "triage-parity.json"),
                Path.of("..", "tools", "data", "triage-parity.json"),
                Path.of("tools", "data", "triage-parity.json"));
        for (Path p : candidates) {
            Path abs = p.toAbsolutePath().normalize();
            if (Files.isRegularFile(abs)) {
                return abs;
            }
        }
        throw new IllegalStateException("找不到 tools/data/triage-parity.json（从 "
                + Path.of(".").toAbsolutePath() + " 起算）；前后端差分门禁不得跳过");
    }
}
