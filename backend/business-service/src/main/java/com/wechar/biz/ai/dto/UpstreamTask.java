package com.wechar.biz.ai.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.time.Instant;
import java.util.List;

/**
 * ai-openapi.yaml 的上游 Task 模型镜像（仅编排所需字段）。命名严格对齐上游 camelCase。
 * 上游 additionalProperties:true（tenantId/priority/modelId/cached 等扩展字段不参与编排），
 * 且全局是严格反序列化，故显式 opt-out 忽略未建模字段，避免上游加字段即打断编排。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record UpstreamTask(
        @JsonProperty("taskId") String taskId,
        @JsonProperty("taskType") String taskType,
        @JsonProperty("status") String status,
        @JsonProperty("progressPhase") String progressPhase,
        @JsonProperty("modelProfile") String modelProfile,
        @JsonProperty("modelId") String modelId,
        @JsonProperty("modelVersion") String modelVersion,
        @JsonProperty("policyVersion") String policyVersion,
        @JsonProperty("cached") Boolean cached,
        @JsonProperty("result") UpstreamTaskResult result,
        @JsonProperty("error") UpstreamTaskError error,
        @JsonProperty("createdAt") Instant createdAt,
        @JsonProperty("finishedAt") Instant finishedAt,
        @JsonProperty("expiresAt") Instant expiresAt) {

    /** 上游 TaskResult（additionalProperties:true，扩展字段忽略）。 */
    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UpstreamTaskResult(
            @JsonProperty("text") String text,
            @JsonProperty("transcript") String transcript,
            @JsonProperty("audioUrl") String audioUrl,
            @JsonProperty("citations") List<UpstreamCitation> citations,
            @JsonProperty("safety") UpstreamSafety safety,
            @JsonProperty("provenance") String provenance,
            @JsonProperty("refused") Boolean refused,
            @JsonProperty("refusalReason") String refusalReason,
            @JsonProperty("language") String language,
            @JsonProperty("hasTimestamps") Boolean hasTimestamps,
            // CARE_PLAN 专属扩展字段（ai-openapi TaskResult additionalProperties:true）。
            // 若不建模，@JsonIgnoreProperties 会在反序列化时静默丢弃 → mapResult 永远拒答，
            // 已生成的建议被吞成"证据不足"（静默吞错红线），故显式保留。
            @JsonProperty("suggestions") com.fasterxml.jackson.databind.JsonNode suggestions,
            @JsonProperty("limitations") String limitations,
            // INTERPRET 专属扩展字段（2026-10-22，健康档案解读接真实模型）：
            // 同样必须显式建模 —— 否则 @JsonIgnoreProperties 会在反序列化时静默丢弃，
            // 解读结果被吞成"无内容"（静默吞错红线）。
            @JsonProperty("summary") String summary,
            @JsonProperty("sections") com.fasterxml.jackson.databind.JsonNode sections,
            // TRIAGE 专属扩展字段（2026-10-24，AI 分诊接真实模型）：
            // ⚠️ 不建模的后果比"丢字段"更严重 —— 业务侧把上游 result 反序列化成本 record 后
            // 再 toJson 落库（applyUpstream），未建模字段在这一步**永久丢失**，
            // 前端拿到的分诊结果只剩 provenance/limitations，科室与置信度全没了。
            @JsonProperty("recommendedDepartments") com.fasterxml.jackson.databind.JsonNode recommendedDepartments) {

        /**
         * 兼容旧 12 参构造（2026-10-22 追加 summary/sections 之前的位置参数写法）。
         * 既有测试与桩代码大量按位置构造，保留此重载可避免无意义的大面积改动。
         */
        public UpstreamTaskResult(String text, String transcript, String audioUrl,
                                  List<UpstreamCitation> citations, UpstreamSafety safety,
                                  String provenance, Boolean refused, String refusalReason,
                                  String language, Boolean hasTimestamps,
                                  com.fasterxml.jackson.databind.JsonNode suggestions,
                                  String limitations) {
            this(text, transcript, audioUrl, citations, safety, provenance, refused, refusalReason,
                    language, hasTimestamps, suggestions, limitations, null, null, null);
        }

        /** 兼容旧 14 参构造（2026-10-24 追加 recommendedDepartments 之前的位置参数写法）。 */
        public UpstreamTaskResult(String text, String transcript, String audioUrl,
                                  List<UpstreamCitation> citations, UpstreamSafety safety,
                                  String provenance, Boolean refused, String refusalReason,
                                  String language, Boolean hasTimestamps,
                                  com.fasterxml.jackson.databind.JsonNode suggestions,
                                  String limitations, String summary,
                                  com.fasterxml.jackson.databind.JsonNode sections) {
            this(text, transcript, audioUrl, citations, safety, provenance, refused, refusalReason,
                    language, hasTimestamps, suggestions, limitations, summary, sections, null);
        }
    }

    /** 上游 TaskError：code 是稳定错误码，上游据此分支，不解析 message。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UpstreamTaskError(
            @JsonProperty("code") String code,
            @JsonProperty("message") String message,
            @JsonProperty("dependency") String dependency,
            @JsonProperty("retryable") Boolean retryable) {
    }

    /**
     * 上游引用（ai-openapi Citation，additionalProperties:true）。
     *
     * ⚠️ 2026-10-24 修复：上游 citations 自 2026-10-22 起是
     * `{index, documentId, chunkId, title, source, score}`，而本 DTO 只建模了
     * sourceId/version/effectiveFrom —— 项目全局是**严格反序列化**，record 又没 opt-out，
     * 一旦 RAG/知识库检索返回非空 citations，整条任务响应解析失败 →
     * 业务侧报 AI_UPSTREAM_MALFORMED(502)，客户端表现为「AI 一直不回复」。
     * 现在补建 documentId/chunkId/source 并显式忽略未知字段。
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UpstreamCitation(
            @JsonProperty("sourceId") String sourceId,
            @JsonProperty("documentId") String documentId,
            @JsonProperty("chunkId") String chunkId,
            @JsonProperty("title") String title,
            @JsonProperty("source") String source,
            @JsonProperty("version") String version,
            @JsonProperty("effectiveFrom") String effectiveFrom,
            @JsonProperty("score") Double score) {

        /** 兼容旧 5 参构造（2026-10-24 追加 documentId/chunkId/source 之前的位置参数写法）。 */
        public UpstreamCitation(String sourceId, String title, String version,
                                String effectiveFrom, Double score) {
            this(sourceId, null, null, title, null, version, effectiveFrom, score);
        }
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record UpstreamSafety(
            @JsonProperty("emergency") Boolean emergency,
            @JsonProperty("level") String level,
            @JsonProperty("message") String message,
            @JsonProperty("provenance") String provenance,
            @JsonProperty("ruleSetVersion") String ruleSetVersion) {
    }

    /** 统一信封（code/message/requestId/serverTime + data）。 */
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Envelope<T>(
            @JsonProperty("code") String code,
            @JsonProperty("message") String message,
            @JsonProperty("requestId") String requestId,
            @JsonProperty("serverTime") Instant serverTime,
            @JsonProperty("data") T data) {
    }
}
