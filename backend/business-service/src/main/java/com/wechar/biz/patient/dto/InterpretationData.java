package com.wechar.biz.patient.dto;

import com.fasterxml.jackson.annotation.JsonInclude;
import java.time.Instant;
import java.util.List;

/**
 * 契约 Interpretation（N2，2026-10-19）：报告 AI 解读。
 * status=READY 时 summary 可空（sections 也可空，客户端显示「暂无可解读内容」）。
 * ⚠️ 红线：不得给出诊断结论/用药剂量/处方；disclaimer 原样下发、客户端原样展示。
 */
@JsonInclude(JsonInclude.Include.NON_NULL)
public record InterpretationData(String recordId, String status, String summary,
                                 List<Section> sections, String disclaimer, Instant generatedAt) {

    /** 分节解读（title/body 必填；abnormal null = 未判定，不显示标记）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Section(String title, String body, Boolean abnormal) {
    }
}
