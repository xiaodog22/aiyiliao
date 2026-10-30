package com.wechar.biz.careplan;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskService;
import com.wechar.biz.careplan.dto.CarePlanData;
import com.wechar.biz.careplan.dto.CarePlanRequest;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Digests;
import com.wechar.biz.consultation.dto.CitationData;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 照护建议服务（M2.4，契约 POST /api/v1/care-plans）：
 *  - 输出定位为生活方式与膳食参考，不构成处方/治疗方案/用药指导（limitations 固定声明）；
 *  - 证据不足/安全策略拒答 → refused + refusalReason 结构化拒答（不用通用养生话术填充）；
 *  - 每条建议带 provenance 与 citations（来源可回溯到经审核资料）；
 *  - 上游失败/超预算 → 503 结构化降级（不把"模型挂了"伪装成拒答，也不 200+空对象）；
 *  - 幂等：同键同体重放落库结果，同键异体 409；goal/constraints 属健康信息，不入日志正文。
 */
@Service
public class CarePlanService {

    private static final Logger log = LoggerFactory.getLogger(CarePlanService.class);

    /** 固定边界声明（契约 limitations 语义：生活方式参考，不构成处方或治疗方案）。 */
    static final String LIMITATIONS =
            "以上为生活方式与膳食参考，不构成处方、治疗方案或用药指导；个体情况请以线下就医和医生意见为准。";

    /**
     * 生成等待预算（超预算 → 503 可重试；不无限轮询、不返回半成品）。
     *
     * ⚠️ 预算必须**大于上游自己的超时**，否则必然提前放弃（2026-10-18 修正）：
     * 原值 30s，而 ai-service 的 CARE_PLAN 执行超时是 60s（AI_CAREPLAN_TIMEOUT_SECONDS 默认 60）。
     * 于是 31~60s 之间完成的生成，本层已先返回 503，把"上游其实能成功"变成失败。
     * 现默认 75s（= 上游 60s + 15s 余量），仍小于网关代理 220s 与前端 180s，
     * 三档关系：业务 75s < 前端 180s < 网关 220s，任一层都不会比下一层更早放弃。
     * 实测（dev，2026-10-18 18:15）：一次真实生成 11s 返回 200。
     */
    private final Duration taskBudget;

    /** 契约字段长度上限。 */
    private static final int TITLE_MAX = 60;
    private static final int DETAIL_MAX = 600;
    private static final int REFUSAL_MAX = 200;

    private final CarePlanRepository repository;
    private final AiTaskService aiTaskService;
    private final ObjectMapper mapper;
    private final Clock clock;

    public CarePlanService(CarePlanRepository repository, AiTaskService aiTaskService,
                           ObjectMapper mapper, Clock clock,
                           @org.springframework.beans.factory.annotation.Value(
                                   "${wechar.care-plan.await-seconds:75}") long awaitSeconds) {
        this.repository = repository;
        this.aiTaskService = aiTaskService;
        this.mapper = mapper;
        this.clock = clock;
        this.taskBudget = Duration.ofSeconds(Math.max(5, awaitSeconds));
    }

    /** 生成结果；replayed 用于 Idempotency-Replayed 头。 */
    public record CarePlanGenerated(CarePlanData plan, boolean replayed) {
    }

    @Transactional
    public CarePlanGenerated create(String userId, String idempotencyKey, CarePlanRequest request) {
        String constraintsJson = request.constraints() == null || request.constraints().isEmpty()
                ? null : toListJson(request.constraints());
        String digest = Digests.sha256Hex(canonical(request.goal(), constraintsJson, request.locale(),
                request.ageBand()));
        Instant now = clock.instant();

        // 幂等：同键同体 → 重放落库结果；同键异体 → 409
        var existing = repository.findByIdempotencyKey(userId, idempotencyKey);
        if (existing.isPresent()) {
            var row = existing.get();
            if (!row.requestDigest().equals(digest)) {
                throw new ApiException("IDEMPOTENCY_KEY_REUSE", HttpStatus.CONFLICT,
                        "Idempotency-Key 已用于不同载荷的请求，请更换键");
            }
            if ("PENDING".equals(row.status())) {
                // 上次事务未收口（理论上随回滚消失）：同键续跑，不产生第二行
                return new CarePlanGenerated(generate(userId, row.id(), request), true);
            }
            return new CarePlanGenerated(replayOf(row), true);
        }

        String id = "cp-" + UUID.randomUUID();
        repository.insert(new CarePlanRepository.CarePlanRow(
                id, userId, request.goal(), constraintsJson,
                request.locale() == null || request.locale().isBlank() ? "zh-CN" : request.locale(),
                "PENDING", null, null, false, null, idempotencyKey, digest, now, null));
        return new CarePlanGenerated(generate(userId, id, request), false);
    }

    // ---------------------------------------------------------------- 生成

    /**
     * 提交 CARE_PLAN 任务并等待收口，结果落库后返回。
     *  - 上游失败/超预算/形态异常 → 结构化 503 冒泡（同事务回滚 → 该行消失，重试即重新生成）；
     *  - 拒答/建议/异常分支都写回同一行，供同键重放，不重复消耗算力；
     *  - goal/constraints 只作为任务输入经内网通道传递，不进日志正文。
     */
    private CarePlanData generate(String userId, String rowId, CarePlanRequest request) {
        Instant now = clock.instant();
        var taskRow = aiTaskService.create(userId, null, "CARE_PLAN",
                null, buildInput(request), null, null,
                request.locale() == null || request.locale().isBlank() ? "zh-CN" : request.locale());
        var task = aiTaskService.await(userId, taskRow.id(), taskBudget);

        if (!"SUCCEEDED".equals(task.status())) {
            // 上游不可用 ≠ 拒答：如实 503（可重试），不静默、不空 200
            log.info("照护建议任务未成功 status={} task={}", task.status(), taskRow.id());
            throw new ApiException("CARE_PLAN_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                    "照护建议暂不可用，请稍后重试", true, null);
        }

        var plan = mapResult(task.result());
        repository.complete(rowId, taskRow.id(), toJson(plan), Boolean.TRUE.equals(plan.refused()),
                plan.refusalReason(), Boolean.TRUE.equals(plan.refused()) ? "REFUSED" : "COMPLETED", now);
        return plan;
    }

    /** 任务输入：目标 + 约束 + 定位声明（不传客户端任意模型名；profile 由服务端决定）。 */
    private String buildInput(CarePlanRequest request) {
        StringBuilder sb = new StringBuilder();
        sb.append("目标：").append(request.goal());
        String ageLabel = ageBandLabel(request.ageBand());
        if (ageLabel != null) {
            sb.append("；年龄段：").append(ageLabel);
        }
        if (request.constraints() != null && !request.constraints().isEmpty()) {
            sb.append("；约束：").append(String.join("、", request.constraints()));
        }
        sb.append("。仅输出生活方式与膳食参考，不构成处方；证据不足时结构化拒答（refused=true + refusalReason）。");
        return sb.toString();
    }

    /**
     * 上游 result → 契约 CarePlan：
     *  - refused=true → 结构化拒答（suggestions 给空数组以满足必填，refusalReason 说明原因）；
     *  - suggestions 缺失或为空但未拒答 → 视为证据不足，按拒答收口（不用空数组冒充"没有建议"）；
     *  - 每条建议强制带 provenance（缺省 AI_GENERATED）与 limitations（固定边界声明）；
     *  - days[]（V21）：按天结构原样解析（label/diet/exercise/sleep），上游未给 → 空数组
     *    （前端养生页 _normalize 兼容：无 days 时回落 suggestions 列表渲染，不用占位话术填充）。
     */
    private CarePlanData mapResult(JsonNode result) {
        if (result == null || result.isNull()) {
            return refuse("上游未返回可展示的照护建议");
        }
        boolean refused = result.hasNonNull("refused") && result.get("refused").asBoolean(false);
        if (refused) {
            String reason = result.hasNonNull("refusalReason")
                    ? cut(result.get("refusalReason").asText(), REFUSAL_MAX)
                    : "证据不足，暂无法给出针对性建议";
            return refuse(reason);
        }

        List<CarePlanData.Suggestion> suggestions = new ArrayList<>();
        JsonNode items = result.path("suggestions");
        if (items.isArray()) {
            for (JsonNode n : items) {
                String title = n.path("title").asText(null);
                String detail = n.path("detail").asText(null);
                if (title == null || title.isBlank() || detail == null || detail.isBlank()) {
                    continue; // 缺核心字段的条目不缝合（宁缺毋假）
                }
                suggestions.add(new CarePlanData.Suggestion(
                        cut(title, TITLE_MAX), cut(detail, DETAIL_MAX),
                        n.path("provenance").asText("AI_GENERATED"),
                        mapCitations(n.path("citations"))));
            }
        }
        if (suggestions.isEmpty()) {
            return refuse("证据不足，暂无法给出针对性建议");
        }
        // limitations：上游给出时用上游（更贴合本次上下文），否则用固定边界声明
        String limitations = result.hasNonNull("limitations")
                ? cut(result.get("limitations").asText(), 400) : LIMITATIONS;
        if (!limitations.contains("不构成处方")) {
            // 边界声明被上游弱化时兜底补回（红线：不得表述为处方/治疗方案）
            limitations = cut(limitations + " 本建议不构成处方、治疗方案或用药指导。", 400);
        }
        return new CarePlanData(suggestions, mapDays(result.path("days")), limitations, false, null);
    }

    /**
     * days[] 解析（V21）：容忍脏数据（非数组/非对象/三条全空的条目丢弃），上限 7 天。
     * label 缺失按序号补「第 N 天」；diet/exercise/sleep 缺失按空串（前端不渲染该行）。
     */
    private List<CarePlanData.DayPlan> mapDays(JsonNode days) {
        if (days == null || !days.isArray()) {
            return List.of();
        }
        List<CarePlanData.DayPlan> out = new ArrayList<>();
        for (JsonNode n : days) {
            if (out.size() >= 7 || !n.isObject()) {
                continue;
            }
            String diet = cut(n.path("diet").asText(null), DETAIL_MAX);
            String exercise = cut(n.path("exercise").asText(null), DETAIL_MAX);
            String sleep = cut(n.path("sleep").asText(null), DETAIL_MAX);
            if (isBlank(diet) && isBlank(exercise) && isBlank(sleep)) {
                continue; // 三日全空的条目不展示（不凑数）
            }
            String label = n.path("label").asText(null);
            out.add(new CarePlanData.DayPlan(
                    isBlank(label) ? "第 " + (out.size() + 1) + " 天" : cut(label, 20),
                    isBlank(diet) ? null : diet,
                    isBlank(exercise) ? null : exercise,
                    isBlank(sleep) ? null : sleep));
        }
        return out;
    }

    private static boolean isBlank(String s) {
        return s == null || s.isBlank();
    }

    private List<CitationData> mapCitations(JsonNode array) {
        if (array == null || !array.isArray() || array.isEmpty()) {
            return null;
        }
        List<CitationData> out = new ArrayList<>();
        for (JsonNode n : array) {
            String sourceId = n.path("sourceId").asText(null);
            String title = n.path("title").asText(null);
            if (sourceId == null || title == null) {
                continue; // 契约必填缺失的来源不展示（未审核资料也不得作为来源）
            }
            out.add(new CitationData(cut(sourceId, 120), cut(title, 120),
                    n.path("version").asText(null), n.path("effectiveFrom").asText(null),
                    n.path("url").asText(null)));
        }
        return out.isEmpty() ? null : out;
    }

    /** 结构化拒答（suggestions/days 空数组满足契约必填；不编造建议条目）。 */
    private static CarePlanData refuse(String reason) {
        return new CarePlanData(List.of(), List.of(), LIMITATIONS, true, cut(reason, REFUSAL_MAX));
    }

    private String toJson(CarePlanData plan) {
        try {
            return mapper.writeValueAsString(plan);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("照护建议序列化失败", e);
        }
    }

    private CarePlanData replayOf(CarePlanRepository.CarePlanRow row) {
        if (row.resultJson() != null && !row.resultJson().isBlank()) {
            try {
                return mapper.readValue(row.resultJson(), CarePlanData.class);
            } catch (JsonProcessingException e) {
                log.warn("照护建议落库结果解析失败 id={}", row.id());
                throw new ApiException("CARE_PLAN_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                        "已保存的照护建议读取失败，请重新生成", true, null);
            }
        }
        // 拒答行兜底（result_json 理论上总有值；缺失即如实降级，不空 200）
        if (row.refused()) {
            return new CarePlanData(List.of(), List.of(), LIMITATIONS, true,
                    row.refusalReason() == null ? "证据不足，暂无法给出针对性建议" : row.refusalReason());
        }
        throw new ApiException("CARE_PLAN_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                "照护建议结果缺失，请重新生成", true, null);
    }

    /** 年龄段只映射为中文标签进提示词（不传精确年龄，避免可识别信息外溢）。 */
    private static String ageBandLabel(String ageBand) {
        if (ageBand == null || ageBand.isBlank()) {
            return null;
        }
        return switch (ageBand) {
            case "child" -> "儿童";
            case "elderly" -> "老年";
            default -> "成人";
        };
    }

    private static String canonical(String... parts) {
        StringBuilder sb = new StringBuilder();
        for (String p : parts) {
            sb.append(p == null ? "" : p).append('|');
        }
        return Digests.sha256Hex(sb.toString());
    }

    private String toListJson(List<String> values) {
        try {
            return mapper.writeValueAsString(values);
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private static String cut(String text, int max) {
        if (text == null) {
            return null;
        }
        return text.length() <= max ? text : text.substring(0, max - 1) + "…";
    }
}
