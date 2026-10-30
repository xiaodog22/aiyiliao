package com.wechar.biz.ai;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.dto.UpstreamTask;
import com.wechar.biz.common.ApiException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * AI 任务编排（M2.2，任务书 §M2 / docs/v4/03 §7）：
 *  - 业务侧 ai_tasks 表是任务的权威行；上游任务 ID 存 upstream_task_id；
 *  - O-02 未定稿：状态同步唯一靠轮询 GET /internal/v1/tasks/{id}，绝不等待回调；
 *  - 轮询必须有总超时预算：超预算仍非终态 → 按 EXPIRED 处理，不无限轮询、不把"一直没结果"
 *    呈现成"正在思考"；
 *  - 任务结果仅 SUCCEEDED 出现；失败以稳定错误码透传，不解析 message；
 *  - 取消幂等：对终态任务重复取消返回同一终态。
 */
@Service
public class AiTaskService {

    private static final Logger log = LoggerFactory.getLogger(AiTaskService.class);

    /** 任务总超时预算（超预算按 EXPIRED；契约 AiTask.expiresAt 语义）。 */
    static final Duration TASK_BUDGET = Duration.ofMinutes(2);

    /** 上游终态集合（契约 TaskStatus）。 */
    private static final java.util.Set<String> TERMINAL =
            java.util.Set.of("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED");

    private final AiTaskRepository repository;
    private final AiTaskClient client;
    private final ObjectMapper mapper;
    private final Clock clock;

    public AiTaskService(AiTaskRepository repository, AiTaskClient client, ObjectMapper mapper, Clock clock) {
        this.repository = repository;
        this.client = client;
        this.mapper = mapper;
        this.clock = clock;
    }

    /** 创建任务（受理即 QUEUED；上游提交失败 → 本行不落，异常冒泡为结构化 503）。 */
    @Transactional
    public AiTaskRow create(String userId, String consultationId, String taskType,
                            String inputRef, String inputInline, String requestedProfile) {
        return create(userId, consultationId, taskType, inputRef, inputInline, requestedProfile, null, null);
    }

    /** 创建任务（语音任务带 voice/locale）。 */
    @Transactional
    public AiTaskRow create(String userId, String consultationId, String taskType,
                            String inputRef, String inputInline, String requestedProfile,
                            String voice, String locale) {
        Instant now = clock.instant();
        String id = "task-" + UUID.randomUUID();
        // 上游幂等键由业务任务 ID 派生：业务重试复用同一行 → 上游也只产生一份算力
        UpstreamTask accepted = client.submit(userId, taskType, inputRef, inputInline,
                requestedProfile, "biz-" + id, voice, locale);

        repository.insert(new AiTaskRow(id, userId, consultationId, taskType, "QUEUED",
                accepted.progressPhase(), accepted.modelProfile(),
                accepted.modelId(), accepted.modelVersion(),
                accepted.policyVersion() == null ? null : accepted.policyVersion(),
                inputRef, accepted.taskId(), null, null, null, null,
                now, null, now.plus(TASK_BUDGET)));
        return repository.findById(id).orElseThrow();
    }

    /**
     * 查询任务（契约 GET /ai/tasks/{taskId}，断线恢复的权威路径）：
     * 本地行 + 按需同步一次上游终态；超预算 → EXPIRED。
     */
    @Transactional
    public AiTaskData get(String userId, String taskId) {
        AiTaskRow row = ownedRow(userId, taskId);
        return toData(sync(row));
    }

    /**
     * 取消任务（契约 DELETE /ai/tasks/{taskId}）：本地已终态 → 同终态返回（幂等）；
     * 非终态 → 传递取消信号并同步。
     */
    @Transactional
    public AiTaskData cancel(String userId, String taskId, String reason) {
        AiTaskRow row = ownedRow(userId, taskId);
        if (TERMINAL.contains(row.status())) {
            return toData(row); // 幂等：同一终态
        }
        try {
            UpstreamTask upstream = client.cancel(row.upstreamTaskId(), reason);
            repository.applyUpstream(row.id(), upstream.status(), upstream.progressPhase(),
                    upstream.result() == null ? null : toJson(upstream.result()),
                    upstream.error() == null ? null : upstream.error().code(),
                    upstream.error() == null ? null : upstream.error().message(),
                    upstream.error() == null || upstream.error().retryable() == null
                            ? null : upstream.error().retryable(),
                    upstream.modelId(), upstream.modelVersion(),
                    clock.instant(), upstream.expiresAt());
        } catch (ApiException e) {
            // 上游不可达时本地仍置 CANCELLED（用户已明确撤回；不假装任务还在跑）
            if ("AI_UNAVAILABLE".equals(e.getCode())) {
                repository.forceCancel(row.id(), clock.instant());
            } else {
                throw e;
            }
        }
        return toData(repository.findById(taskId).orElseThrow());
    }

    /** 当前任务行（身份范围过滤：不属于当前用户 → 404，不泄露存在性）。 */
    public AiTaskRow ownedRow(String userId, String taskId) {
        return repository.findById(taskId)
                .filter(r -> userId.equals(r.userId()))
                .orElseThrow(() -> new ApiException("TASK_NOT_FOUND", HttpStatus.NOT_FOUND, "任务不存在"));
    }

    /**
     * 轮询直到终态或超预算（voice 域同步合成用；聊天域用 SSE + GET 断线恢复，不走这里）。
     * 超预算返回当前非终态由调用方按超时降级——绝不无限轮询。
     */
    public AiTaskData await(String userId, String taskId, Duration budget) {
        Instant deadline = clock.instant().plus(budget);
        AiTaskData data = get(userId, taskId);
        while (!TERMINAL.contains(data.status()) && clock.instant().isBefore(deadline)) {
            try {
                Thread.sleep(AWAIT_POLL_MS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return data;
            }
            data = get(userId, taskId);
        }
        return data;
    }

    private static final long AWAIT_POLL_MS = 400L;

    /** 就绪探针（models 能力状态用）：不可达返回 null，调用方降级 unavailable。 */
    public com.wechar.biz.ai.dto.UpstreamReadiness readiness() {
        return client.readiness();
    }

    /** 会话下最近任务（详情页展示最新生成状态）。 */
    public java.util.Optional<AiTaskRow> findLatestForConsultation(String consultationId) {
        return repository.findLatestForConsultation(consultationId);
    }

    /** 会话下最近一次 TRIAGE 任务（AI 分诊防抖复用；2026-10-24）。 */
    public java.util.Optional<AiTaskRow> findLatestTriageForConsultation(String consultationId) {
        return repository.findLatestByType(consultationId, "TRIAGE");
    }

    /** 会话下最近非终态任务（confirmations 终止源任务生成用）。 */
    public java.util.Optional<AiTaskRow> findLatestActiveForConsultation(String consultationId) {
        return repository.findLatestActiveForConsultation(consultationId);
    }

    /** 本地行 + 上游按需同步（非终态且未超预算 → 轮询一次；超预算 → EXPIRED）。 */
    private AiTaskRow sync(AiTaskRow row) {
        if (TERMINAL.contains(row.status())) {
            return row;
        }
        Instant now = clock.instant();
        if (row.expiresAt() != null && now.isAfter(row.expiresAt())) {
            // 超预算：不无限轮询、不呈现"正在思考"；按 EXPIRED 收口
            repository.expire(row.id(), now);
            log.info("AI 任务超预算按 EXPIRED 处理 task={}", row.id());
            return repository.findById(row.id()).orElseThrow();
        }
        UpstreamTask upstream;
        try {
            upstream = client.get(row.upstreamTaskId());
        } catch (ApiException e) {
            // 上游暂不可达：保留本地状态（QUEUED/RUNNING）供重试，不吞错也不谎报终态
            if ("TASK_NOT_FOUND".equals(e.getCode())) {
                repository.markFailed(row.id(), "UPSTREAM_TASK_LOST", "上游任务已丢失", true, clock.instant());
                return repository.findById(row.id()).orElseThrow();
            }
            throw e;
        }
        repository.applyUpstream(row.id(), upstream.status(), upstream.progressPhase(),
                upstream.result() == null ? null : toJson(upstream.result()),
                upstream.error() == null ? null : upstream.error().code(),
                upstream.error() == null ? null : upstream.error().message(),
                upstream.error() == null || upstream.error().retryable() == null
                        ? null : upstream.error().retryable(),
                upstream.modelId(), upstream.modelVersion(),
                clock.instant(), upstream.expiresAt());
        return repository.findById(row.id()).orElseThrow();
    }

    // ------------------------------------------------------------------

    public record AiTaskRow(String id, String userId, String consultationId, String taskType, String status,
                            String progressPhase, String modelProfile, String modelId, String modelVersion,
                            String policyVersion, String inputRef,
                            String upstreamTaskId, String resultJson, String errorCode, String errorMessage,
                            Boolean errorRetryable, Instant createdAt, Instant updatedAt, Instant expiresAt) {
    }

    /** 契约 AiTask（result 仅 SUCCEEDED 出现；error 仅 FAILED 出现；progressPhase 只是阶段名）。 */
    @com.fasterxml.jackson.annotation.JsonInclude(com.fasterxml.jackson.annotation.JsonInclude.Include.NON_NULL)
    public record AiTaskData(String taskId, String taskType, String status, String progressPhase,
                             String modelProfile, String policyVersion,
                             com.fasterxml.jackson.databind.JsonNode result,
                             com.fasterxml.jackson.databind.JsonNode error,
                             Instant createdAt, Instant updatedAt, Instant expiresAt) {
    }

    public AiTaskData toData(AiTaskRow row) {
        com.fasterxml.jackson.databind.JsonNode result = null;
        if ("SUCCEEDED".equals(row.status()) && row.resultJson() != null) {
            result = parse(row.resultJson());
        }
        com.fasterxml.jackson.databind.JsonNode error = null;
        if ("FAILED".equals(row.status())) {
            error = mapper.createObjectNode()
                    .put("code", row.errorCode() == null ? "AI_TASK_FAILED" : row.errorCode())
                    .put("message", row.errorMessage() == null ? "AI 任务失败" : row.errorMessage())
                    .put("requestId", com.wechar.biz.common.RequestIds.current())
                    .put("retryable", row.errorRetryable() == null ? Boolean.FALSE : row.errorRetryable())
                    .put("serverTime", clock.instant().toString());
        }
        return new AiTaskData(row.id(), row.taskType(), row.status(), row.progressPhase(),
                row.modelProfile(), row.policyVersion(), result, error,
                row.createdAt(), row.updatedAt(), row.expiresAt());
    }

    private com.fasterxml.jackson.databind.JsonNode parse(String json) {
        try {
            return mapper.readTree(json);
        } catch (JsonProcessingException e) {
            log.warn("任务结果 JSON 解析失败（忽略该字段）");
            return null;
        }
    }

    private String toJson(Object value) {
        try {
            return mapper.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException("任务结果序列化失败", e);
        }
    }
}
