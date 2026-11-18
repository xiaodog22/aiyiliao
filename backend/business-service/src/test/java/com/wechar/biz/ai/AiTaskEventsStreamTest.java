package com.wechar.biz.ai;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.atLeastOnce;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.timeout;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.consultation.ConsultationService;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.web.servlet.mvc.method.annotation.ResponseBodyEmitter;
import org.springframework.web.servlet.mvc.method.annotation.SseEmitter;

/**
 * 任务事件流「实时增量」改造（对外流式二期，2026-11-17）。
 *
 * <p>为什么用假 emitter 而不用 MockMvc：这里要验证的恰恰是**两个线程并发写同一个 emitter**
 * （轮询线程发 status/终态，上游读取线程发 delta）。MockMvc 走完整个 MVC 栈后线程早已结束，
 * 看不到交错。直接驱动 streamEvents 能同时锁住三条不变量：
 * <ul>
 *   <li>有实时增量时，终态<b>不得</b>再补发整段（否则客户端追加出重复文本）；</li>
 *   <li>没有实时增量（上游流不可用）时，终态<b>必须</b>补发整段（否则用户看不到答案）；</li>
 *   <li>失败任务只发 error，不发 delta。</li>
 * </ul>
 */
class AiTaskEventsStreamTest {

    private static final String USER = "dev-user-1";
    private static final String TASK = "t-stream-1";
    /** 上游任务 id（`t_xxx`）与对外 taskId（`task-<uuid>`）不同命名空间，回归锁：传错必 404。 */
    private static final String UPSTREAM = "t_upstream_1";

    private final ObjectMapper mapper = new ObjectMapper();

    /**
     * 用 Mockito 捕获 SSE 帧，而不是继承 SseEmitter。
     *
     * <p>踩过的坑：`SseEmitter.send(SseEventBuilder)` 内部是 `invokespecial` 直调父类
     * `ResponseBodyEmitter.send(Set)`，子类覆写**拦不到**；而未初始化的 emitter 会把帧
     * 静默塞进 earlySendAttempts，测试里表现为「什么都没收到」。Mock 掉 send 才是可靠切面。
     */
    private static String bodyOf(SseEmitter emitter) throws java.io.IOException {
        ArgumentCaptor<SseEmitter.SseEventBuilder> cap =
                ArgumentCaptor.forClass(SseEmitter.SseEventBuilder.class);
        verify(emitter, atLeastOnce()).send(cap.capture());
        StringBuilder sb = new StringBuilder();
        for (SseEmitter.SseEventBuilder builder : cap.getAllValues()) {
            for (ResponseBodyEmitter.DataWithMediaType item : builder.build()) {
                if (item.getData() instanceof String text) {
                    sb.append(text);
                }
            }
        }
        return sb.toString();
    }

    /** 等流收尾（complete 被调用）后返回全部帧文本。 */
    private static String awaitBody(SseEmitter emitter, long ms) throws java.io.IOException {
        verify(emitter, timeout(ms)).complete();
        return bodyOf(emitter);
    }

    private AiTaskController controller(AiTaskService service, AiTaskClient client) {
        AuthService auth = mock(AuthService.class);
        CurrentUserContext ctx = mock(CurrentUserContext.class);
        when(auth.ensureUser(any())).thenReturn(USER);
        when(ctx.currentUserId()).thenReturn(USER);
        when(service.ownedRow(anyString(), anyString())).thenReturn(row(UPSTREAM));
        return new AiTaskController(service, client, mock(ConsultationService.class),
                auth, ctx, mapper);
    }

    private AiTaskService.AiTaskRow row(String upstreamTaskId) {
        Instant now = Instant.now();
        return new AiTaskService.AiTaskRow(TASK, USER, null, "CHAT", "RUNNING",
                null, "large-upgrade", null, null, "POLICY-v1", null,
                upstreamTaskId, null, null, null, null, now, now, now.plusSeconds(3600));
    }

    private AiTaskService.AiTaskData task(String status, String text) throws Exception {
        var result = text == null ? null : mapper.readTree("{\"text\":\"" + text + "\"}");
        return new AiTaskService.AiTaskData(TASK, "CHAT", status, null,
                "large-upgrade", "POLICY-v1", result, null,
                Instant.now(), Instant.now(), Instant.now().plusSeconds(3600));
    }

    /** 构造一条会吐出指定增量的上游流（结尾带 done，验证 done 不被转发）。 */
    private AiTaskStream upstream(String... deltas) {
        StringBuilder sse = new StringBuilder();
        for (int i = 0; i < deltas.length; i++) {
            sse.append("event: delta\nid: ").append(i + 1)
                    .append("\ndata: {\"text\":\"").append(deltas[i]).append("\"}\n\n");
        }
        sse.append("event: done\nid: 99\ndata: {\"finishReason\":\"stop\"}\n\n");
        return new AiTaskStream(
                new ByteArrayInputStream(sse.toString().getBytes(StandardCharsets.UTF_8)),
                mapper, TASK);
    }

    @Test
    void 有实时增量时终态不再补发整段() throws Exception {
        AiTaskService service = mock(AiTaskService.class);
        AiTaskClient client = mock(AiTaskClient.class);
        when(service.get(USER, TASK))
                .thenReturn(task("RUNNING", null))
                .thenReturn(task("SUCCEEDED", "你好，在的"));
        when(client.openStream(UPSTREAM)).thenReturn(upstream("你好", "，在的"));

        SseEmitter emitter = mock(SseEmitter.class);
        controller(service, client).streamEvents(USER, TASK, 0L, emitter);
        String body = awaitBody(emitter, 8_000);

        Assertions.assertTrue(body.contains("你好"), "实时增量应逐块下发");
        Assertions.assertTrue(body.contains("，在的"));
        Assertions.assertFalse(body.contains("\"text\":\"你好，在的\""),
                "已有实时增量时不得再补发整段 delta");
        Assertions.assertTrue(body.contains("completed"));
    }

    @Test
    void 上游流不可用时终态补发整段() throws Exception {
        AiTaskService service = mock(AiTaskService.class);
        AiTaskClient client = mock(AiTaskClient.class);
        when(service.get(USER, TASK))
                .thenReturn(task("RUNNING", null))
                .thenReturn(task("SUCCEEDED", "整段兜底文本"));
        when(client.openStream(UPSTREAM)).thenReturn(null);

        SseEmitter emitter = mock(SseEmitter.class);
        controller(service, client).streamEvents(USER, TASK, 0L, emitter);
        String body = awaitBody(emitter, 8_000);

        Assertions.assertTrue(body.contains("\"text\":\"整段兜底文本\""),
                "无实时增量时必须补发整段，否则用户看不到答案");
        Assertions.assertTrue(body.contains("completed"));
    }

    @Test
    void 失败任务只发error不发delta() throws Exception {
        AiTaskService service = mock(AiTaskService.class);
        AiTaskClient client = mock(AiTaskClient.class);
        when(service.get(USER, TASK)).thenReturn(task("FAILED", null));
        when(client.openStream(UPSTREAM)).thenReturn(null);

        SseEmitter emitter = mock(SseEmitter.class);
        controller(service, client).streamEvents(USER, TASK, 0L, emitter);
        String body = awaitBody(emitter, 8_000);

        Assertions.assertTrue(body.contains("AI_TASK_FAILED"));
        Assertions.assertFalse(body.contains("\"type\":\"delta\""), "失败任务不得下发 delta");
    }

    @Test
    void 重连不接实时流_由终态整段替换() throws Exception {
        AiTaskService service = mock(AiTaskService.class);
        AiTaskClient client = mock(AiTaskClient.class);
        when(service.get(USER, TASK))
                .thenReturn(task("RUNNING", null))
                .thenReturn(task("SUCCEEDED", "完整答案"));
        // 带 Last-Event-ID（resumeSeq=5）时绝不应打开上游流：中途接入必然缺前缀
        when(client.openStream(UPSTREAM)).thenReturn(upstream("不该出现"));

        SseEmitter emitter = mock(SseEmitter.class);
        controller(service, client).streamEvents(USER, TASK, 5L, emitter);
        String body = awaitBody(emitter, 8_000);

        Assertions.assertFalse(body.contains("不该出现"), "重连不得复用实时流");
        Assertions.assertTrue(body.contains("\"text\":\"完整答案\""), "重连由终态整段补齐");
    }

    /**
     * M-01 回归锁（2026-11-18）：实时增量与权威全文不一致时必须整段替换。
     *
     * <p>两个真实场景在此合流：上游订阅队列满丢块（慢消费者）、任务运行中途才建立订阅
     * （小程序不发 Last-Event-ID，缺前缀）。两者都表现为 seq 连续、completed 正常，
     * 用户却拿到缺中段/缺前缀的残文 —— 必须由终态校验兜住。
     */
    @Test
    void 增量与权威全文不一致时终态整段替换() throws Exception {
        AiTaskService service = mock(AiTaskService.class);
        AiTaskClient client = mock(AiTaskClient.class);
        when(service.get(USER, TASK))
                .thenReturn(task("RUNNING", null))
                .thenReturn(task("SUCCEEDED", "你好，在的"));
        // 上游只吐出后半段：前缀已丢（或这条连接中途才接入）
        when(client.openStream(UPSTREAM)).thenReturn(upstream("，在的"));

        SseEmitter emitter = mock(SseEmitter.class);
        controller(service, client).streamEvents(USER, TASK, 0L, emitter);
        String body = awaitBody(emitter, 8_000);

        Assertions.assertTrue(body.contains("\"text\":\"你好，在的\""), "必须补发权威全文");
        Assertions.assertTrue(body.contains("\"replace\":true"),
                "补发必须是替换语义：客户端追加会得到残文+全文的重复文本");
        Assertions.assertTrue(body.contains("completed"));
    }

    /**
     * 回归锁：openStream 必须收到**上游任务 id**。
     *
     * <p>2026-11-17 真机冒烟踩过：控制器把对外 `task-<uuid>` 传给上游，
     * ai-service 返回 404，openStream 按契约静默返回 null，于是整条流退化成
     * 「一个整段 delta」——功能看起来正常，实际流式全丢。这条断言就是钉死它。
     */
    @Test
    void 上游流订阅必须使用upstreamTaskId() throws Exception {
        AiTaskService service = mock(AiTaskService.class);
        AiTaskClient client = mock(AiTaskClient.class);
        when(service.get(USER, TASK))
                .thenReturn(task("RUNNING", null))
                .thenReturn(task("SUCCEEDED", "你好"));
        when(client.openStream(UPSTREAM)).thenReturn(upstream("你好"));

        SseEmitter emitter = mock(SseEmitter.class);
        controller(service, client).streamEvents(USER, TASK, 0L, emitter);
        awaitBody(emitter, 8_000);

        verify(client).openStream(UPSTREAM);
        verify(client, org.mockito.Mockito.never()).openStream(TASK);
    }
}
