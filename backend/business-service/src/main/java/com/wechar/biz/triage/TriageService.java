package com.wechar.biz.triage;

import com.wechar.biz.catalog.CatalogRepository;
import com.wechar.biz.triage.dto.EmergencyCheckData;
import com.wechar.biz.triage.dto.EmergencyCheckRequest;
import com.wechar.biz.triage.dto.RecommendedDepartment;
import com.wechar.biz.triage.dto.SafetyNoticeData;
import com.wechar.biz.triage.dto.TriageRequest;
import com.wechar.biz.triage.dto.TriageResultData;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 导诊服务（M1.6 / 任务书规则 7）：
 *  - 服务端不降低 localRuleHits 的等级（非空 → EMERGENCY）；
 *  - 无命中走确定性关键词规则（红旗词表 TRIAGE-RULES-001）；
 *  - recommendedDepartments 落到真实 departments 数据；
 *  - provenance=RULE_RESULT（规则结果，不伪装 AI）；limitations 固定文案必现；
 *  - emergency-check 与 recommendations 复用同一规则引擎。
 */
@Service
public class TriageService {

    private final TriageRuleEngine engine;
    private final CatalogRepository catalog;

    public TriageService(TriageRuleEngine engine, CatalogRepository catalog) {
        this.engine = engine;
        this.catalog = catalog;
    }

    @Transactional(readOnly = true)
    public TriageResultData recommend(TriageRequest request) {
        TriageRuleEngine.RuleOutcome outcome = engine.evaluate(request.localRuleHits(), request.symptoms());

        SafetyNoticeData safety = new SafetyNoticeData(
                outcome.emergency(),
                outcome.level(),
                outcome.emergency()
                        ? "命中急症红旗：" + String.join("、", outcome.matchedRules()) + "。" + TriageRuleEngine.emergencyAdvice()
                        : "未命中急症红旗规则。",
                "RULE_RESULT",
                TriageRuleEngine.RULESET_VERSION);

        List<RecommendedDepartment> departments = List.of();
        String guidance = TriageRuleEngine.normalGuidance();
        if (outcome.emergency()) {
            guidance = TriageRuleEngine.emergencyAdvice();
            // 08F §4b：红旗触发时主推荐须切「急诊科」（安全优先：不让用户拿专科门诊号去排队，
            // 与前端 docs/v4/03「红旗优先」口径一致，服务端亦不得给专科排队建议）。
            // 急诊科不在 departments 只读目录内（§1 禁止改目录）→ 按合成条目下发，
            // id 取前端导航字典同名键（miniprogram/utils/triage-kb.js → 'emergency'）。
            departments = List.of(new RecommendedDepartment("emergency", "急诊科",
                    "命中急症红旗：" + String.join("、", outcome.matchedRules()),
                    "RULE_RESULT", 1.0));
        } else {
            departments = mapDepartments(request.symptoms());
        }

        return new TriageResultData(safety, departments, guidance, TriageRuleEngine.LIMITATIONS);
    }

    /** 急症检查（同一引擎）。 */
    public EmergencyCheckData check(EmergencyCheckRequest request) {
        TriageRuleEngine.RuleOutcome outcome = engine.scanText(request.text());
        return new EmergencyCheckData(outcome.emergency(), outcome.level(), outcome.matchedRules(),
                TriageRuleEngine.RULESET_VERSION, outcome.advice());
    }

    /** 关键词命中 → 真实 departments（消化/呼吸/心血管/骨科）；confidence 按命中词数 0.6~0.9。 */
    private List<RecommendedDepartment> mapDepartments(String symptoms) {
        List<TriageRuleEngine.DeptHit> hits = engine.recommendDepartments(symptoms);
        if (hits.isEmpty()) {
            return List.of();
        }
        Map<String, String> nameToId = new HashMap<>();
        for (var d : catalog.listDepartments(null, null)) {
            nameToId.put(d.name(), d.id());
        }
        return hits.stream().map(h -> {
            double confidence = Math.min(0.9, 0.6 + 0.1 * Math.max(0, h.hits() - 1));
            String id = nameToId.get(h.departmentName());
            if (id == null) {
                return null; // 只落到真实 departments 数据；不存在则不返回该条
            }
            return new RecommendedDepartment(id, h.departmentName(),
                    "症状关键词命中：" + String.join("、", h.matchedKeywords()),
                    "RULE_RESULT", confidence);
        }).filter(java.util.Objects::nonNull).toList();
    }
}
