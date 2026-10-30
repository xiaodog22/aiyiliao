package com.wechar.biz.careplan.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import com.wechar.biz.consultation.dto.CitationData;
import java.util.List;

/**
 * 契约 CarePlan：输出定位为生活方式与膳食参考，不构成处方/治疗方案/用药指导。
 * 每条建议必须带 provenance 与 limitations；证据不足 → refused + refusalReason（结构化拒答，
 * 不用通用养生话术填充）。
 *
 * V21（2026-10-21）：补按天结构 days[]（遗留清单第 5 页 #1）——前端养生页 _normalize 早已
 * 兼容 days[]，缺的只是后端下发。label 形如「第 1 天」；diet/exercise/sleep 为当日
 * 膳食/运动/睡眠安排。拒答时 days 为空数组（NON_NULL 下整体省略）。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record CarePlanData(List<Suggestion> suggestions, List<DayPlan> days, String limitations,
                           Boolean refused, String refusalReason) {

    /** 单日安排：三条都可能为空串（模型未覆盖该维度时前端不渲染该行，不用占位话术填充）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record DayPlan(String label, String diet, String exercise, String sleep) {
    }

    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Suggestion(String title, String detail, String provenance,
                             List<CitationData> citations) {
    }
}
