package com.wechar.biz.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.dto.UpstreamReadiness;
import com.wechar.biz.ai.dto.UpstreamTask;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.RequestIds;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;

/**
 * ai-service 内网任务编排客户端（HTTP 实现）：
 *  - POST /internal/v1/tasks（Idempotency-Key 必填；重试复用同一键，避免一份算力变两份）
 *  - GET  /internal/v1/tasks/{taskId}（O-02 定稿前唯一权威状态路径）
 *  - POST /internal/v1/tasks/{taskId}/cancel（天然幂等：终态任务返回同一终态）
 *  - GET  /internal/health/ready（能力状态；不可达返回 null 由调用方降级）
 * 红线：
 *  - 内网地址与服务令牌绝不进入对外响应/错误消息/日志正文（契约：内网地址不外泄）；
 *  - 上游不可达/超时 → 503 AI_UNAVAILABLE（可重试），绝不 200+空对象、绝不静默吞错；
 *  - 上游错误码原样透传为稳定错误码，不解析 message 文本。
 */
@Primary
@Component
public class HttpAiTaskClient implements AiTaskClient {

    private static final Logger log = LoggerFactory.getLogger(HttpAiTaskClient.class);

    private static final Duration CONNECT_TIMEOUT = Duration.ofSeconds(3);
    private static final Duration READ_TIMEOUT = Duration.ofSeconds(10);

    private final AiClientConfig config;
    private final ObjectMapper mapper;
    private final HttpClient http;

    public HttpAiTaskClient(AiClientConfig config, ObjectMapper mapper) {
        this.config = config;
        this.mapper = mapper;
        this.http = HttpClient.newBuilder()
                .version(HttpClient.Version.HTTP_1_1) // 关键：只用 HTTP/1.1，见下方注释
                .connectTimeout(CONNECT_TIMEOUT)
                .proxy(DIRECT_PROXY_SELECTOR)
                .build();
    }

    /**
     * 两条内网通信红线（实测踩坑后固化）：
     *  1) Java HttpClient 对 http:// 默认发 h2c 升级（Connection: Upgrade + HTTP2-Settings），
     *     uvicorn 不支持该升级 → 上游判 400 "非法 JSON"/"Invalid HTTP request"，任务提交全挂；
     *     强制 HTTP_1_1 后不再携带升级头。
     *  2) 不读系统代理（Windows WinINET 代理会被 Java 默认继承，内网地址绕道本地代理）；
     *     ai-service 只在内网，一律直连。
     */
    private static final java.net.ProxySelector DIRECT_PROXY_SELECTOR = new java.net.ProxySelector() {
        @Override
        public java.util.List<java.net.Proxy> select(URI uri) {
            return java.util.List.of(java.net.Proxy.NO_PROXY);
        }

        @Override
        public void connectFailed(URI uri, java.net.SocketAddress sa, java.io.IOException ioe) {
            // 直连失败由调用方按 503 结构化处理，此处无需动作
        }
    };

    @Override
    public UpstreamTask submit(String userId, String taskType, String inputRef, String inputInline,
                               String requestedProfile, String idempotencyKey) {
        return submit(userId, taskType, inputRef, inputInline, requestedProfile, idempotencyKey, null, null);
    }

    @Override
    public UpstreamTask submit(String userId, String taskType, String inputRef, String inputInline,
                               String requestedProfile, String idempotencyKey, String voice, String locale) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("tenantId", config.getTenantId());
        body.put("userId", userId);
        body.put("taskType", taskType);
        body.put("policyVersion", config.getPolicyVersion());
        body.put("traceId", traceId());
        if (inputRef != null && !inputRef.isBlank()) {
            body.put("inputRef", inputRef); // 首选：敏感原文/音频引用不经过第二跳
        } else {
            body.put("inputInline", inputInline);
        }
        if (requestedProfile != null && !requestedProfile.isBlank()) {
            body.put("requestedProfile", requestedProfile);
        }
        if (voice != null && !voice.isBlank()) {
            body.put("voice", voice);
        }
        body.put("locale", locale == null || locale.isBlank() ? "zh-CN" : locale);
        body.put("priority", "INTERACTIVE");

        String payloadJson = toJson(body);
        HttpRequest request = base("/internal/v1/tasks")
                .header("Idempotency-Key", idempotencyKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payloadJson, java.nio.charset.StandardCharsets.UTF_8))
                .build();
        return send(request, "提交任务");
    }

    @Override
    public UpstreamTask get(String taskId) {
        return send(base("/internal/v1/tasks/" + taskId).GET().build(), "查询任务");
    }

    @Override
    public UpstreamTask cancel(String taskId, String reason) {
        Map<String, Object> body = reason == null ? Map.of() : Map.of("reason", reason);
        return send(base("/internal/v1/tasks/" + taskId + "/cancel")
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(toJson(body))).build(), "取消任务");
    }

    @Override
    public UpstreamReadiness readiness() {
        try {
            HttpResponse<String> response = http.send(base("/internal/health/ready").GET().build(),
                    HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                return null; // 探针失败：调用方降级为 unavailable，不 200+空对象
            }
            return mapper.readValue(response.body(), UpstreamReadiness.class);
        } catch (java.io.IOException e) {
            return null; // 内网不可达/响应不可解析：能力入口如实反映 unavailable
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return null;
        }
    }

    // ------------------------------------------------------------------

    private HttpRequest.Builder base(String path) {
        HttpRequest.Builder builder = HttpRequest.newBuilder()
                .uri(URI.create(stripSlash(config.getBaseUrl()) + path))
                .timeout(READ_TIMEOUT)
                .header("X-Request-Id", RequestIds.current())
                .header("X-Trace-Id", traceId())
                .header("Accept", "application/json");
        if (config.getToken() != null && !config.getToken().isBlank()) {
            builder.header("Authorization", "Bearer " + config.getToken());
        }
        return builder;
    }

    /** 同一任务的多次轮询共享 traceId（契约 TraceId 参数语义）。 */
    private static String traceId() {
        String id = MDC.get("traceId");
        if (id == null) {
            id = MDC.get(RequestIds.MDC_KEY);
        }
        return id != null ? id : UUID.randomUUID().toString();
    }

    private UpstreamTask send(HttpRequest request, String action) {
        HttpResponse<String> response;
        try {
            response = http.send(request, HttpResponse.BodyHandlers.ofString());
        } catch (java.io.IOException e) {
            log.warn("ai-service {} 失败：连接异常（内网不可达/超时）", action);
            throw unavailable(action + "失败：AI 服务暂不可达");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw unavailable(action + "失败：请求被中断");
        }

        int status = response.statusCode();
        String payload = response.body() == null ? "" : response.body();

        if (status == 200) {
            UpstreamTask.Envelope<UpstreamTask> env = parseEnvelope(payload);
            if (env == null || env.data() == null) {
                // 上游 200 但无 data：可识别错误，绝不当成功
                throw new ApiException("AI_UPSTREAM_MALFORMED", HttpStatus.BAD_GATEWAY,
                        action + "失败：上游响应格式异常", true, null);
            }
            return env.data();
        }
        // 4xx/5xx：从信封中提取稳定错误码（不解析 message 文本）
        String code = extractErrorCode(payload);
        if (status == 409) {
            throw new ApiException(code == null ? "AI_IDEMPOTENCY_CONFLICT" : code, HttpStatus.CONFLICT,
                    action + "冲突（幂等键不同载荷或任务状态冲突）");
        }
        if (status == 429) {
            throw new ApiException(code == null ? "AI_RATE_LIMITED" : code, HttpStatus.TOO_MANY_REQUESTS,
                    action + "被限流：AI 服务繁忙，请稍后重试", true, null);
        }
        if (status == 503) {
            // QUEUE_FULL / CAPABILITY_UNAVAILABLE 等：结构化降级，入口级提示
            throw new ApiException(code == null ? "AI_UNAVAILABLE" : code, HttpStatus.SERVICE_UNAVAILABLE,
                    action + "失败：AI 能力暂不可用", true, null);
        }
        if (status == 404) {
            throw new ApiException("UPSTREAM_TASK_NOT_FOUND", HttpStatus.NOT_FOUND,
                    action + "失败：上游任务不存在或不属于当前作用域");
        }
        log.warn("ai-service {} 返回不可识别状态 {}（已按上游错误处理，不吞错）", action, status);
        throw unavailable(action + "失败：上游返回异常状态");
    }

    private static ApiException unavailable(String message) {
        return new ApiException("AI_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE, message, true, null);
    }

    private UpstreamTask.Envelope<UpstreamTask> parseEnvelope(String payload) {
        try {
            JsonNode node = mapper.readTree(payload);
            UpstreamTask data = mapper.treeToValue(node.get("data"), UpstreamTask.class);
            return new UpstreamTask.Envelope<>(
                    node.path("code").asText(null), node.path("message").asText(null),
                    node.path("requestId").asText(null), null, data);
        } catch (JsonProcessingException e) {
            log.warn("ai-service 响应解析失败（格式异常）");
            return null;
        }
    }

    private String extractErrorCode(String payload) {
        try {
            JsonNode node = mapper.readTree(payload);
            String code = node.path("code").asText(null);
            return code == null || code.isBlank() ? null : code;
        } catch (JsonProcessingException e) {
            return null;
        }
    }

    private String toJson(Object body) {
        try {
            return mapper.writeValueAsString(body);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("请求体序列化失败", e);
        }
    }

    private static String stripSlash(String url) {
        return url.endsWith("/") ? url.substring(0, url.length() - 1) : url;
    }
}
