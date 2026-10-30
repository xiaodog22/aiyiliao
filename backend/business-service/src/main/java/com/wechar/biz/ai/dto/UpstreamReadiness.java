package com.wechar.biz.ai.dto;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonInclude;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;

/**
 * ai-openapi.yaml 的 ReadinessResult 镜像（就绪探针）。
 * status: ok/degraded/down（degraded 不重启；down 才是核心依赖不可用）。
 * models[].status: loaded/loading/not_loaded/unavailable（权重缺失 = unavailable，如实反映）。
 */
@JsonIgnoreProperties(ignoreUnknown = true)
@JsonInclude(JsonInclude.Include.NON_NULL)
public record UpstreamReadiness(
        @JsonProperty("status") String status,
        @JsonProperty("dependencies") List<Dependency> dependencies,
        @JsonProperty("models") List<Model> models) {

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Dependency(
            @JsonProperty("name") String name,
            @JsonProperty("status") String status,
            @JsonProperty("detail") String detail,
            @JsonProperty("latencyMs") Integer latencyMs) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    @JsonInclude(JsonInclude.Include.NON_NULL)
    public record Model(
            @JsonProperty("role") String role,
            @JsonProperty("modelId") String modelId,
            @JsonProperty("status") String status,
            @JsonProperty("resident") Boolean resident) {
    }
}
