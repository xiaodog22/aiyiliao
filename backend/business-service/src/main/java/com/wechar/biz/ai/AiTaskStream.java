package com.wechar.biz.ai;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * ai-service 任务增量流句柄（对外流式二期）。
 *
 * <p>用途：把 ai-service `GET /internal/v1/tasks/{taskId}/stream` 的 SSE 增量
 * （一期冻结契约：start / delta / done / error）读出来，逐块交给业务侧转发。
 *
 * <p>三条设计约束，每条都来自实测：
 * <ol>
 *   <li><b>用 InputStreamReader 而不是 BodyHandlers.ofLines()</b>：需要能可靠地
 *       从另一个线程 close() 打断阻塞读（任务终态后必须收流，否则线程挂在 readLine）。
 *       InputStreamReader 内部做增量解码，汉字不会被拆坏。</li>
 *   <li><b>只取 delta，done/error 一律不转发</b>：任务的权威终态是业务侧的
 *       `GET /api/v1/ai/tasks/{taskId}`（轮询），由它统一产出 completed/error；
 *       两处都发会导致客户端收到两个终态事件。</li>
 *   <li><b>读失败不抛给调用方</b>：上游断流/客户端断开都只意味着「没有更多增量」，
 *       终态仍由轮询补齐 —— 抛出会把一次可恢复的抖动变成整条流失败。</li>
 * </ol>
 */
public final class AiTaskStream implements AutoCloseable {

    /** 增量回调（在读取线程上执行，实现必须轻量、不得阻塞）。 */
    public interface Listener {
        void onDelta(String text);
    }

    private final InputStream body;
    private final BufferedReader reader;
    private final ObjectMapper mapper;
    private final CountDownLatch finished = new CountDownLatch(1);
    private final String taskId;

    private volatile boolean closed;
    private volatile Listener listener;
    private Thread thread;

    AiTaskStream(InputStream body, ObjectMapper mapper, String taskId) {
        this.body = body;
        this.reader = new BufferedReader(new InputStreamReader(body, StandardCharsets.UTF_8));
        this.mapper = mapper;
        this.taskId = taskId;
    }

    /** 启动读取线程（守护线程，不阻塞 Tomcat 线程池）。 */
    public void start(Listener target) {
        this.listener = target;
        Thread t = new Thread(this::pump, "ai-task-stream-" + taskId);
        t.setDaemon(true);
        this.thread = t;
        t.start();
    }

    /** 有界等待增量排空（任务已终态，但队列里可能还有最后几块），超时即放弃。 */
    public void awaitDrain(long millis) {
        try {
            finished.await(millis, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    @Override
    public void close() {
        closed = true;
        try {
            body.close(); // 打断阻塞中的 readLine
        } catch (IOException ignore) {
            // 关闭失败无补救动作：读取线程会因 closed 标记退出
        }
        if (thread != null) {
            thread.interrupt();
        }
    }

    // ------------------------------------------------------------------

    private void pump() {
        String event = "";
        StringBuilder data = new StringBuilder();
        try {
            String line;
            while (!closed && (line = reader.readLine()) != null) {
                if (line.isEmpty()) {
                    dispatch(event, data);
                    event = "";
                    data.setLength(0);
                    continue;
                }
                if (line.charAt(0) == ':') {
                    continue; // 注释帧（心跳）
                }
                int idx = line.indexOf(':');
                String field = idx < 0 ? line : line.substring(0, idx);
                String value = idx < 0 ? "" : line.substring(idx + 1);
                if (!value.isEmpty() && value.charAt(0) == ' ') {
                    value = value.substring(1);
                }
                if ("event".equals(field)) {
                    event = value;
                } else if ("data".equals(field)) {
                    if (data.length() > 0) {
                        data.append('\n');
                    }
                    data.append(value);
                }
            }
            dispatch(event, data);
        } catch (IOException e) {
            // 上游断流 / 本端 close() 打断：都只是「没有更多增量」，终态由轮询负责
        } finally {
            finished.countDown();
        }
    }

    private void dispatch(String event, StringBuilder data) {
        if (closed || data.length() == 0 || !"delta".equals(event)) {
            return;
        }
        Listener target = listener;
        if (target == null) {
            return;
        }
        try {
            JsonNode node = mapper.readTree(data.toString());
            String text = node.path("text").asText("");
            if (!text.isEmpty()) {
                target.onDelta(text);
            }
        } catch (Exception e) {
            // 单帧不可解析：丢弃该帧继续读，不能因为一帧脏数据中断整条流
        }
    }
}
