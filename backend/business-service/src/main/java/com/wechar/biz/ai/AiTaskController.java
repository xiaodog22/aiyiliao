package com.wechar.biz.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.consultation.ConsultationService;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * AI 任务控制器（M2.2，契约 /api/v1/ai/tasks 域）：
 *  GET    /api/v1/ai/tasks/{taskId}          断线恢复的权威路径（终态才允许结束等待）
 *  DELETE /api/v1/ai/tasks/{taskId}          取消（幂等：终态任务重复取消返回同一终态）
 *  GET    /api/v1/ai/tasks/{taskId}/events   SSE 事件流（增量通道，权威仍是 GET 单查）
 * SSE 实现说明：上游 ai-openapi 未提供事件流端点，业务侧用"读本地权威行 + 轮询上游"
 * 合成 9 类事件（accepted/status/delta/citation/safety/tts/completed/cancelled/error），
 * 绝不伪造 progressPhase 百分比；delta 只承载上游确实给出的文本。
 */
@RestController
@RequestMapping("/api/v1/ai/tasks")
public class AiTaskController {

    private static final Logger log = LoggerFactory.getLogger(AiTaskController.class);

    private static final Set<String> TERMINAL =
            Set.of("SUCCEEDED", "FAILED", "CANCELLED", "EXPIRED");

    /** SSE 轮询间隔与总时长（跟任务预算对齐，不无限挂着连接）。 */
    private static final long POLL_INTERVAL_MS = 1000L;
    private static final long SSE_TIMEOUT_MS = 130_000L;
    private static final int TASK_ID_MAX = 64;

    private final AiTaskService aiTaskService;
    private final ConsultationService consultationService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;
    private final ObjectMapper mapper;

    public AiTaskController(AiTaskService aiTaskService, ConsultationService consultationService,
                            AuthService authService, CurrentUserContext currentUserContext,
                            ObjectMapper mapper) {
        this.aiTaskService = aiTaskService;
        this.consultationService = consultationService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
        this.mapper = mapper;
    }

    /** 任务状态查询（断线恢复的权威路径；data.result 仅 SUCCEEDED 出现）。 */
    @GetMapping("/{taskId}")
    public ResponseEntity<Envelope<AiTaskService.AiTaskData>> get(@PathVariable String taskId) {
        requireTaskId(taskId);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var data = aiTaskService.get(userId, taskId);
        // 读时物化（2026-10-24）：CHAT 任务完成 → 把 AI 回复落库成 assistant 消息。
        // 不做的话下一轮 chatContext 里没有 AI 自己的话，模型会重复追问；
        // 患者重进会话也看不到任何 AI 回复。物化幂等（消息 id = msg-{taskId}）。
        if ("SUCCEEDED".equals(data.status())) {
            consultationService.materializeChatReply(aiTaskService.ownedRow(userId, taskId));
        }
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), data));
    }

    /** 取消任务（幂等：终态重复取消返回同一终态）。 */
    @DeleteMapping("/{taskId}")
    public ResponseEntity<Envelope<AiTaskService.AiTaskData>> cancel(@PathVariable String taskId) {
        requireTaskId(taskId);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                aiTaskService.cancel(userId, taskId, "USER_CANCELLED")));
    }

    /**
     * SSE 事件流（契约：id: + event: + data:，data 为 AiTaskEvent JSON）。
     * 响应头强制 Cache-Control: no-store 与 X-Accel-Buffering: no（反代不得缓冲）。
     * 流只是增量通道：completed 后仍以 GET 单查终态为准。
     */
    @GetMapping(value = "/{taskId}/events", produces = MediaType.TEXT_EVENT_STREAM_VALUE)
    public SseEmitter events(@PathVariable String taskId,
                             @RequestHeader(value = "Last-Event-ID", required = false) String lastEventId,
                             HttpServletResponse response) throws IOException {
        requireTaskId(taskId);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        // 身份范围过滤先行（他人/不存在 → 404，且发生在 SSE 响应头之前）
        aiTaskService.ownedRow(userId, taskId);

        response.setHeader("Cache-Control", "no-store");
        response.setHeader("X-Accel-Buffering", "no");
        response.setHeader("Connection", "keep-alive");

        long resumeSeq = parseLastEventId(lastEventId);
        SseEmitter emitter = new SseEmitter(SSE_TIMEOUT_MS);
        emitter.onTimeout(emitter::complete);
        emitter.onError(e -> log.debug("SSE 连接中断 task={}", taskId));

        // 事件流交给工作线程轮询合成（SSE 挂起不占请求线程）
        Thread worker = new Thread(() -> streamEvents(userId, taskId, resumeSeq, emitter),
                "ai-task-sse-" + taskId);
        worker.setDaemon(true);
        worker.start();
        return emitter;
    }

    // ---------------------------------------------------------------- 内部

    /** 合成事件流：accepted → 轮询 status/delta/citation/safety/tts → completed/cancelled/error。 */
    private void streamEvents(String userId, String taskId, long resumeSeq, SseEmitter emitter) {
        EventSeq seq = new EventSeq(resumeSeq);
        try {
            AiTaskService.AiTaskData first = aiTaskService.get(userId, taskId);
            send(emitter, seq, taskId, "accepted", Map.of(
                    "taskId", taskId, "status", first.status(),
                    "occurredAt", Instant.now().toString()));
            send(emitter, seq, taskId, "status", statusPayload(taskId, first));

            String lastStatus = first.status();
            while (!TERMINAL.contains(lastStatus)) {
                Thread.sleep(POLL_INTERVAL_MS);
                AiTaskService.AiTaskData current = aiTaskService.get(userId, taskId);
                if (!current.status().equals(lastStatus)) {
                    lastStatus = current.status();
                    send(emitter, seq, taskId, "status", statusPayload(taskId, current));
                }
            }

            AiTaskService.AiTaskData finalTask = aiTaskService.get(userId, taskId);
            emitTerminal(emitter, seq, taskId, finalTask);
            emitter.complete();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            emitter.complete();
        } catch (ApiException e) {
            // 任务在流期间被删除/身份失效：按 error 事件收口（绝不静默断流）
            try {
                send(emitter, seq, taskId, "error", Map.of(
                        "taskId", taskId, "error", Map.of(
                                "code", e.getCode(), "message", e.getMessage() == null ? "" : e.getMessage(),
                                "requestId", RequestIds.current(), "retryable", e.isRetryable(),
                                "serverTime", Instant.now().toString()),
                        "occurredAt", Instant.now().toString()));
                emitter.complete();
            } catch (Exception ignore) {
                emitter.complete();
            }
        } catch (Exception e) {
            log.warn("SSE 合成流异常 task={} cause={}", taskId, e.getClass().getSimpleName());
            emitter.completeWithError(e);
        }
    }

    /** 终态收口：SUCCEEDED → delta（完整文本）+ citation + safety + [tts] + completed；CANCELLED → cancelled；其余 → error。 */
    private void emitTerminal(SseEmitter emitter, EventSeq seq, String taskId,
                              AiTaskService.AiTaskData task) throws IOException {
        switch (task.status()) {
            case "SUCCEEDED" -> {
                var result = task.result();
                if (result != null && result.hasNonNull("text")) {
                    send(emitter, seq, taskId, "delta", Map.of(
                            "taskId", taskId, "text", result.get("text").asText(),
                            "occurredAt", Instant.now().toString()));
                }
                if (result != null && result.has("citations") && result.get("citations").isArray()) {
                    for (var citation : result.get("citations")) {
                        send(emitter, seq, taskId, "citation", Map.of(
                                "taskId", taskId, "citation", citation,
                                "occurredAt", Instant.now().toString()));
                    }
                }
                if (result != null && result.hasNonNull("safety")) {
                    send(emitter, seq, taskId, "safety", Map.of(
                            "taskId", taskId, "safety", result.get("safety"),
                            "occurredAt", Instant.now().toString()));
                }
                if (result != null && result.hasNonNull("audioUrl")) {
                    send(emitter, seq, taskId, "tts", Map.of(
                            "taskId", taskId, "audioUrl", result.get("audioUrl").asText(),
                            "occurredAt", Instant.now().toString()));
                }
                send(emitter, seq, taskId, "completed", Map.of(
                        "taskId", taskId, "status", "SUCCEEDED", "occurredAt", Instant.now().toString()));
            }
            case "CANCELLED" -> send(emitter, seq, taskId, "cancelled", Map.of(
                    "taskId", taskId, "status", "CANCELLED", "occurredAt", Instant.now().toString()));
            default -> {
                // FAILED / EXPIRED：结构化 error 事件（EXPIRED 也走 error，客户端据此停止等待）
                Map<String, Object> error = new LinkedHashMap<>();
                error.put("code", task.error() != null && task.error().hasNonNull("code")
                        ? task.error().get("code").asText()
                        : ("EXPIRED".equals(task.status()) ? "AI_TASK_EXPIRED" : "AI_TASK_FAILED"));
                error.put("message", task.error() != null && task.error().hasNonNull("message")
                        ? task.error().get("message").asText() : "AI 任务未成功完成");
                error.put("requestId", RequestIds.current());
                error.put("retryable", task.error() != null && task.error().hasNonNull("retryable")
                        ? task.error().get("retryable").asBoolean() : false);
                error.put("serverTime", Instant.now().toString());
                Map<String, Object> payload = new LinkedHashMap<>();
                payload.put("taskId", taskId);
                payload.put("error", error);
                payload.put("occurredAt", Instant.now().toString());
                send(emitter, seq, taskId, "error", payload);
            }
        }
    }

    /** AiTaskEvent 的 status 载荷（additionalProperties:false：只放契约字段）。 */
    private static Map<String, Object> statusPayload(String taskId, AiTaskService.AiTaskData task) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("taskId", taskId);
        payload.put("status", task.status());
        payload.put("occurredAt", Instant.now().toString());
        return payload;
    }

    /** 发送一帧 SSE（id/event/data）。 */
    private void send(SseEmitter emitter, EventSeq seq, String taskId, String type,
                      Map<String, Object> payload) throws IOException {
        long next = seq.next();
        Map<String, Object> event = new LinkedHashMap<>(payload);
        event.put("seq", next);
        event.put("type", type);
        // AiTaskEvent additionalProperties:false：只保留契约字段
        Map<String, Object> clean = new LinkedHashMap<>();
        clean.put("taskId", taskId);
        clean.put("seq", next);
        clean.put("type", type);
        copyIfPresent(event, clean, "text");
        copyIfPresent(event, clean, "citation");
        copyIfPresent(event, clean, "safety");
        copyIfPresent(event, clean, "status");
        copyIfPresent(event, clean, "audioUrl");
        copyIfPresent(event, clean, "error");
        clean.put("occurredAt", event.getOrDefault("occurredAt", Instant.now().toString()));
        emitter.send(SseEmitter.event()
                .id(String.valueOf(next))
                .name(type)
                .data(mapper.writeValueAsString(clean), MediaType.APPLICATION_JSON));
    }

    private static void copyIfPresent(Map<String, Object> from, Map<String, Object> to, String key) {
        if (from.containsKey(key) && from.get(key) != null) {
            to.put(key, from.get(key));
        }
    }

    /** Last-Event-ID 续传游标（客户端给的 seq；此后帧按序重发时跳过已收的）。 */
    private static long parseLastEventId(String lastEventId) {
        if (lastEventId == null || lastEventId.isBlank()) {
            return 0;
        }
        try {
            return Math.max(0, Long.parseLong(lastEventId.trim()));
        } catch (NumberFormatException e) {
            return 0; // 非法游标按从头开始处理，客户端以 GET 单查兜底
        }
    }

    /** 单调递增事件序号（跨帧唯一，供断线续传与去重）。 */
    private static final class EventSeq {
        private long value;

        private EventSeq(long resumeFrom) {
            this.value = resumeFrom;
        }

        private long next() {
            return ++value;
        }
    }

    /** 契约 taskId maxLength 64；越界 → 422。 */
    private static void requireTaskId(String taskId) {
        if (taskId == null || taskId.isBlank() || taskId.length() > TASK_ID_MAX) {
            throw new ApiException("VALIDATION_FAILED", HttpStatus.UNPROCESSABLE_ENTITY,
                    "taskId 长度须为 1~64 字符");
        }
    }
}
