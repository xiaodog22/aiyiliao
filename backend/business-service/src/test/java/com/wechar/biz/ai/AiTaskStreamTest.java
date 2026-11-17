package com.wechar.biz.ai;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.Test;

/**
 * 上游增量流句柄（对外流式二期，2026-11-17）。
 *
 * <p>为什么单独测这一层：它是「ai-service 的 SSE」到「业务侧 delta 事件」的唯一转换点，
 * 三条不变量一旦破了都不会报错、只会静默出错：
 * <ul>
 *   <li>把 start/done/error 也转发 → 客户端收到两个终态，或把内部字段当正文；</li>
 *   <li>一帧脏 JSON 抛异常 → 整条流中断，用户只看到半句话；</li>
 *   <li>中文解码错误 → 满屏 `�`（历史 gesture 模块就是逐块解码踩的）。</li>
 * </ul>
 */
class AiTaskStreamTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private AiTaskStream open(String sse) {
        InputStream in = new ByteArrayInputStream(sse.getBytes(StandardCharsets.UTF_8));
        return new AiTaskStream(in, mapper, "t-test");
    }

    @Test
    void 只转发Delta_终态与元信息一律不转发() {
        String sse = "event: start\nid: 1\ndata: {\"taskId\":\"t-test\",\"taskType\":\"CHAT\"}\n\n"
                + "event: delta\nid: 2\ndata: {\"text\":\"建议先\"}\n\n"
                + "event: delta\nid: 3\ndata: {\"text\":\"多休息\"}\n\n"
                + "event: done\nid: 4\ndata: {\"finishReason\":\"stop\",\"cached\":false}\n\n";
        List<String> got = new CopyOnWriteArrayList<>();
        AiTaskStream stream = open(sse);
        stream.start(got::add);
        stream.awaitDrain(2000);
        stream.close();

        Assertions.assertEquals(List.of("建议先", "多休息"), got);
    }

    @Test
    void 脏帧被丢弃_后续帧继续转发() {
        String sse = "event: delta\nid: 1\ndata: {\"text\":\"前半\"}\n\n"
                + "event: delta\nid: 2\ndata: 半截{不是JSON\n\n"
                + "event: delta\nid: 3\ndata: {\"text\":\"后半\"}\n\n";
        List<String> got = new CopyOnWriteArrayList<>();
        AiTaskStream stream = open(sse);
        stream.start(got::add);
        stream.awaitDrain(2000);
        stream.close();

        Assertions.assertEquals(List.of("前半", "后半"), got);
    }

    @Test
    void 注释心跳与空帧不影响正文() {
        String sse = ": ping\n\n"
                + "\n\n"
                + "event: delta\ndata: {\"text\":\"你好\"}\n\n";
        List<String> got = new CopyOnWriteArrayList<>();
        AiTaskStream stream = open(sse);
        stream.start(got::add);
        stream.awaitDrain(2000);
        stream.close();

        Assertions.assertEquals(List.of("你好"), got);
    }

    @Test
    void 中文与转义字符原样保留() {
        String sse = "event: delta\ndata: {\"text\":\"头晕、恶心，血压 150/95\"}\n\n"
                + "event: delta\ndata: {\"text\":\"\\n建议复测\"}\n\n";
        List<String> got = new CopyOnWriteArrayList<>();
        AiTaskStream stream = open(sse);
        stream.start(got::add);
        stream.awaitDrain(2000);
        stream.close();

        Assertions.assertEquals("头晕、恶心，血压 150/95", got.get(0));
        Assertions.assertEquals("\n建议复测", got.get(1));
    }

    @Test
    void 空正文不回调_避免客户端插入空片段() {
        String sse = "event: delta\ndata: {\"text\":\"\"}\n\n"
                + "event: delta\ndata: {\"text\":\"有内容\"}\n\n";
        List<String> got = new CopyOnWriteArrayList<>();
        AiTaskStream stream = open(sse);
        stream.start(got::add);
        stream.awaitDrain(2000);
        stream.close();

        Assertions.assertEquals(List.of("有内容"), got);
    }
}
