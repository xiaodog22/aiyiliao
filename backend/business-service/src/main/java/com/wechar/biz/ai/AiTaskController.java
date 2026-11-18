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
    /** 任务已终态后，等待上游增量排空的上限（末几块可能还在管道里）。 */
    private static final long STREAM_DRAIN_MS = 2_000L;
    private static final int TASK_ID_MAX = 64;

    private final AiTaskService aiTaskService;
    private final AiTaskClient aiTaskClient;
    private final ConsultationService consultationService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;
    private final ObjectMapper mapper;

    public AiTaskController(AiTaskService aiTaskService, AiTaskClient aiTaskClient,
                            ConsultationService consultationService,
                            AuthService authService, CurrentUserContext currentUserContext,
                            ObjectMapper mapper) {
        this.aiTaskService = aiTaskService;
        this.aiTaskClient = aiTaskClient;
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
     *
     * <p>2026-11-17（对外流式二期）：`delta` 由「终态整段一次发」改为
     * <b>边生成边发</b>，数据源是 ai-service 的一期冻结增量契约。
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

    /**
     * 事件流：accepted → status → [实时 delta…] → status 变化 → completed/cancelled/error。
     *
     * <p>delta 现在有两个来源，客户端统一「收到就追加」，两种都正确：
     * <ul>
     *   <li><b>实时</b>：任务运行中，逐块转发 ai-service 的增量；</li>
     *   <li><b>兜底/替换</b>：缓存命中 / 非 CHAT / 上游流不可用 / 断线重连 → 终态发一整段；
     *       若已发过增量但与权威全文不一致（丢块、缺前缀），该整段带 {@code replace=true}，
     *       客户端替换而不是追加。</li>
     * </ul>
     * 终态权威始终是本服务轮询 `GET /{taskId}` 的结果，上游的 done/error 一律不转发
     * （否则客户端会收到两个终态事件）。
     *
     * <p>包级可见（非 private）：单测直接驱动这条流，避免为了拿 SseEmitter 而走一遍
     * HTTP 装配（走完装配后线程早已结束，看不到「轮询线程 + 增量线程」的真实交错）。
     */
    void streamEvents(String userId, String taskId, long resumeSeq, SseEmitter emitter) {
        SseSink sink = new SseSink(emitter, taskId, new EventSeq(resumeSeq), mapper);
        AiTaskStream upstream = null;
        try {
            AiTaskService.AiTaskData first = aiTaskService.get(userId, taskId);
            sink.send("accepted", Map.of(
                    "taskId", taskId, "status", first.status(),
                    "occurredAt", Instant.now().toString()));
            sink.send("status", statusPayload(taskId, first));

            if (!TERMINAL.contains(first.status())) {
                // 断线重连（带 Last-Event-ID）不接实时流：上游没有 replay buffer，
                // 中途接入必然缺前缀，拼出来是「后半段」。改由终态整段替换，语义安全。
                if (resumeSeq == 0) {
                    // ⚠️ 必须用 upstreamTaskId（`t_xxx`），不是对外 taskId（`task-<uuid>`）：
                    // 两者是不同命名空间，传错上游直接 404，openStream 按契约静默返回 null，
                    // 表现成「流式端点正常但只有一个整段 delta」——2026-11-17 真机冒烟踩过。
                    upstream = aiTaskClient.openStream(aiTaskService.ownedRow(userId, taskId).upstreamTaskId());
                    if (upstream != null) {
                        upstream.start(sink::sendDelta);
                    }
                }
                String lastStatus = first.status();
                while (!TERMINAL.contains(lastStatus)) {
                    Thread.sleep(POLL_INTERVAL_MS);
                    AiTaskService.AiTaskData current = aiTaskService.get(userId, taskId);
                    if (!current.status().equals(lastStatus)) {
                        lastStatus = current.status();
                        sink.send("status", statusPayload(taskId, current));
                    }
                }
            }

            if (upstream != null) {
                upstream.awaitDrain(STREAM_DRAIN_MS);
            }
            emitTerminal(sink, aiTaskService.get(userId, taskId));
            sink.complete();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            sink.complete();
        } catch (ApiException e) {
            // 任务在流期间被删除/身份失效：按 error 事件收口（绝不静默断流）
            try {
                sink.send("error", Map.of(
                        "taskId", taskId, "error", Map.of(
                                "code", e.getCode(), "message", e.getMessage() == null ? "" : e.getMessage(),
                                "requestId", RequestIds.current(), "retryable", e.isRetryable(),
                                "serverTime", Instant.now().toString()),
                        "occurredAt", Instant.now().toString()));
                sink.complete();
            } catch (Exception ignore) {
                sink.complete();
            }
        } catch (Exception e) {
            log.warn("SSE 事件流异常 task={} cause={}", taskId, e.getClass().getSimpleName());
            sink.completeWithError(e);
        } finally {
            if (upstream != null) {
                upstream.close();
            }
        }
    }

    /**
     * 终态收口：SUCCEEDED → [delta] + citation + safety + [tts] + completed；CANCELLED → cancelled；其余 → error。
     *
     * <p>delta 的收口规则（2026-11-18 收紧，修复 M-01）：
     * 终态一定以 `GET /{taskId}` 的**权威全文**校验一次本连接实际转发出去的增量拼接结果。
     * 两条路径都走这条校验：
     * <ul>
     *   <li>零增量（缓存命中 / 非 CHAT / 上游流不可用 / 带 Last-Event-ID 重连）→ 直接整段下发；</li>
     *   <li>有增量但与权威全文<b>不一致</b>（上游队列满丢块、任务运行中途才接入缺前缀）→
     *       下发 {@code replace=true} 的整段，客户端据此清空已收正文重放。</li>
     * </ul>
     * 只有「增量拼接 === 权威全文」时才不再补发 —— 否则客户端会看到缺中段/缺前缀的残文，
     * 而 seq 连续、completed 正常，没有任何完整性信号。
     */
    private void emitTerminal(SseSink sink, AiTaskService.AiTaskData task) throws IOException {
        String taskId = sink.taskId();
        switch (task.status()) {
            case "SUCCEEDED" -> {
                var result = task.result();
                String full = result != null && result.hasNonNull("text")
                        ? result.get("text").asText() : null;
                if (full != null && !full.isEmpty()
                        && (sink.deltaCount() == 0 || !full.equals(sink.forwardedText()))) {
                    sink.sendReplacingDelta(full);
                }
                if (result != null && result.has("citations") && result.get("citations").isArray()) {
                    for (var citation : result.get("citations")) {
                        sink.send("citation", Map.of(
                                "taskId", taskId, "citation", citation,
                                "occurredAt", Instant.now().toString()));
                    }
                }
                if (result != null && result.hasNonNull("safety")) {
                    sink.send("safety", Map.of(
                            "taskId", taskId, "safety", result.get("safety"),
                            "occurredAt", Instant.now().toString()));
                }
                if (result != null && result.hasNonNull("audioUrl")) {
                    sink.send("tts", Map.of(
                            "taskId", taskId, "audioUrl", result.get("audioUrl").asText(),
                            "occurredAt", Instant.now().toString()));
                }
                sink.send("completed", Map.of(
                        "taskId", taskId, "status", "SUCCEEDED", "occurredAt", Instant.now().toString()));
            }
            case "CANCELLED" -> sink.send("cancelled", Map.of(
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
                sink.send("error", payload);
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

    /**
     * SSE 发送口：把「轮询线程」与「增量读取线程」对同一个 emitter 的写入串行化。
     *
     * <p>为什么必须加锁：SseEmitter 不是线程安全的。对外流式二期之后，delta 由上游读取线程
     * 推送、status/终态由轮询线程推送，两个线程并发 send 会把帧写乱（表现为客户端收到
     * 半截 JSON 或错乱 seq）。
     *
     * <p>断开处理：客户端断开后 send 抛 IOException，增量线程必须**就此停手但不得取消任务**
     * （切后台的用户回来还要看答案），轮询线程仍继续跑到终态落库。
     */
    private static final class SseSink {

        private final SseEmitter emitter;
        private final String taskId;
        private final EventSeq seq;
        private final ObjectMapper mapper;
        /** 已转发增量条数与拼接结果：与 deltaCount() 同一把锁维护，终态拿它跟权威全文比对。 */
        private final StringBuilder forwarded = new StringBuilder();
        private int sent;
        private volatile boolean broken;

        private SseSink(SseEmitter emitter, String taskId, EventSeq seq, ObjectMapper mapper) {
            this.emitter = emitter;
            this.taskId = taskId;
            this.seq = seq;
            this.mapper = mapper;
        }

        private String taskId() {
            return taskId;
        }

        private synchronized int deltaCount() {
            return sent;
        }

        /** 本连接已转发出去的增量拼接（终态校验用；按发生顺序）。 */
        private synchronized String forwardedText() {
            return forwarded.toString();
        }

        /** 增量推送：失败即视为客户端已断开，只停推送，不影响任务本身。 */
        private void sendDelta(String text) {
            if (broken) {
                return;
            }
            try {
                // 自增与 append 必须和 deltaCount()/forwardedText() 同锁：
                // 轮询线程在终态判定时可能读到旧值，误判「无增量」而重复补发整段。
                synchronized (this) {
                    if (broken) {
                        return;
                    }
                    send("delta", deltaPayload(text, false));
                    sent++;
                    forwarded.append(text);
                }
            } catch (IOException e) {
                broken = true;
            }
        }

        /**
         * 整段替换：`replace=true` 让客户端清空已收正文后重放本段（终态校验不一致时使用）。
         *
         * <p>不能只发 `text`：客户端「收到就追加」会把残文和新全文拼在一起。
         */
        private void sendReplacingDelta(String text) throws IOException {
            if (broken) {
                throw new IOException("SSE 连接已断开");
            }
            synchronized (this) {
                send("delta", deltaPayload(text, true));
                sent++;
                forwarded.setLength(0);
                forwarded.append(text);
            }
        }

        private Map<String, Object> deltaPayload(String text, boolean replace) {
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("taskId", taskId);
            payload.put("text", text);
            if (replace) {
                payload.put("replace", true);
            }
            payload.put("occurredAt", Instant.now().toString());
            return payload;
        }

        /** 发送一帧 SSE（id/event/data）。 */
        private synchronized void send(String type, Map<String, Object> payload) throws IOException {
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
            copyIfPresent(event, clean, "replace");
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

        private void complete() {
            try {
                emitter.complete();
            } catch (Exception ignore) {
                // 已断开/已完成的重复收尾无副作用
            }
        }

        private void completeWithError(Throwable e) {
            try {
                emitter.completeWithError(e);
            } catch (Exception ignore) {
                // 同上
            }
        }
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
