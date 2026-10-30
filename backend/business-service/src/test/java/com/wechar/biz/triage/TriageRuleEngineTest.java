package com.wechar.biz.triage;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import org.junit.jupiter.api.Test;

/** triage 关键规则：服务端不得降低客户端 localRuleHits 的等级；红旗词表确定性命中。 */
class TriageRuleEngineTest {

    private final TriageRuleEngine engine = new TriageRuleEngine();

    @Test
    void localRuleHits非空_强制EMERGENCY不降级() {
        var outcome = engine.evaluate(List.of("chest_pain"), "只是有点累");
        assertTrue(outcome.emergency());
        assertEquals("EMERGENCY", outcome.level());
        assertTrue(outcome.matchedRules().contains("chest_pain"));
    }

    @Test
    void 本地命中且服务端文本也有红旗_并集保留() {
        var outcome = engine.evaluate(List.of("local_rule_x"), "突然胸痛还喘不上气");
        assertTrue(outcome.emergency());
        assertEquals("EMERGENCY", outcome.level());
        assertTrue(outcome.matchedRules().contains("local_rule_x"));
        assertTrue(outcome.matchedRules().contains("chest_pain"));
        assertTrue(outcome.matchedRules().contains("dyspnea"));
    }

    @Test
    void 无命中_非急症INFO() {
        var outcome = engine.evaluate(null, "这两天有点消化不良");
        assertFalse(outcome.emergency());
        assertEquals("INFO", outcome.level());
        assertTrue(outcome.matchedRules().isEmpty());
    }

    @Test
    void 空localRuleHits列表_不视为命中() {
        var outcome = engine.evaluate(List.of(), "普通感冒症状");
        assertFalse(outcome.emergency());
    }

    @Test
    void 急症词表_确定性命中() {
        assertTrue(engine.scanText("胸口压得慌").emergency());
        assertTrue(engine.scanText("突然昏迷了").emergency());
        assertTrue(engine.scanText("痰中带血有咯血").emergency());
        assertFalse(engine.scanText("膝盖有点疼").emergency());
    }

    @Test
    void 规则集版本固定() {
        assertEquals("TRIAGE-RULES-001", TriageRuleEngine.RULESET_VERSION);
    }

    // ==================== 08F T1 回归用例 a/b/c/d ====================

    /** a 类：纯口语命中——「肚子疼」归一为「腹痛」后推荐非空且含消化内科。 */
    @Test
    void 回归a_纯口语肚子疼_推荐含消化内科() {
        var hits = engine.recommendDepartments("肚子疼");
        assertFalse(hits.isEmpty(), "纯口语「肚子疼」仍空推荐（缺口-1 复现）");
        assertEquals("消化内科", hits.get(0).departmentName());
        assertTrue(hits.get(0).matchedKeywords().contains("腹痛"));
        // 红旗判定同步走归一层：单纯口语不得误报急症
        assertFalse(engine.scanText("肚子疼").emergency());
    }

    /** b 类：口语 + 红旗——「肚子疼得厉害，还便血」红旗触发，服务端主推荐切急诊科（§4b）。 */
    @Test
    void 回归b_口语加便血红旗_触发且主推荐急诊科() {
        var outcome = engine.evaluate(null, "肚子疼得厉害，还便血");
        assertTrue(outcome.emergency(), "归一后便血红旗未触发（§3.2 红旗不可被削）");
        assertEquals("EMERGENCY", outcome.level());
        assertTrue(outcome.matchedRules().contains("severe_bleeding"));

        // 服务层主推荐：急症 → 急诊科（TriageService.recommend 合成条目；id 与前端
        // miniprogram/utils/triage-kb.js 导航字典 'emergency' 对齐）
        var svc = new TriageService(engine, null);
        var result = svc.recommend(new com.wechar.biz.triage.dto.TriageRequest(
                "肚子疼得厉害，还便血", null, null, null, null));
        assertFalse(result.recommendedDepartments().isEmpty());
        assertEquals("急诊科", result.recommendedDepartments().get(0).departmentName());
    }

    /** c 类：变体等价——归一结果一致，推荐科室一致。 */
    @Test
    void 回归c_肚子疼与腹痛归一等价_推荐一致() {
        assertEquals(TriageNormalizer.normalize("肚子疼"), TriageNormalizer.normalize("腹痛"));
        var h1 = engine.recommendDepartments("肚子疼");
        var h2 = engine.recommendDepartments("腹痛");
        assertFalse(h1.isEmpty());
        assertEquals(h1, h2, "两变体推荐科室不一致");
        // 红旗判定同样等价
        assertEquals(engine.scanText("肚子疼得厉害便血").emergency(),
                engine.scanText("腹痛得厉害便血").emergency());
    }

    /** d 类：幂等 + 兜底——归一稳定；「不舒服」不产生错误专科（回退客户端本地规则
     *  兜底，由前端 PART_PRIMARY 按部位拉正——服务端关键词表不含「不舒服」，不硬造结果）。 */
    @Test
    void 回归d_幂等稳定与不舒服兜底不误判() {
        String n1 = TriageNormalizer.normalize("肚子疼");
        assertEquals(n1, TriageNormalizer.normalize(n1), "归一不幂等");

        // 「不舒服」无标准词映射 → 不产生虚假专科命中
        var hits = engine.recommendDepartments("不舒服");
        assertTrue(hits.isEmpty(), "「不舒服」不应命中任何专科");
        assertFalse(engine.scanText("不舒服").emergency());
        // 无红旗、无专科 → 非急症 INFO，推荐空 → 网关 legacy 适配层回退本地规则（兜底语义）
        var outcome = engine.evaluate(null, "不舒服");
        assertFalse(outcome.emergency());
        assertEquals("INFO", outcome.level());
    }

    /** §2 全表回归：每条映射「归一前后」红旗判定不得被削（归一只做同义词替换）。 */
    @Test
    void 映射表全量_归一不得削红旗() {
        for (var pair : TriageNormalizer.entries()) {
            String src = pair[0];
            String std = TriageNormalizer.normalize(src);
            boolean before = engine.scanText(src).emergency();
            boolean after = engine.scanText(std).emergency();
            assertTrue(!before || after,
                    "红旗被削：" + src + " → " + std + "（before=" + before + ", after=" + after + "）");
        }
    }

    /** §3.3 程度不折叠：程度副词不参与归一，红旗判定按原文本逐词保留。 */
    @Test
    void 程度词不被折叠_归一仅换同义词() {
        assertEquals("有点腹痛", TriageNormalizer.normalize("有点肚子疼"));
        assertEquals("腹痛得很厉害", TriageNormalizer.normalize("肚子疼得很厉害"));
        assertTrue(TriageNormalizer.normalize("非常发烧").contains("非常"));
    }
}
