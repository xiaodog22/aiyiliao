package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.asyncDispatch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskClient;
import com.wechar.biz.ai.dto.UpstreamTask;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import static org.mockito.ArgumentMatchers.any;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * M4.4 契约测试（问诊/AI/语音/照护域）——逐路径对 backend/contracts/business-openapi.yaml：
 * 断言实测状态码 ∈ 该操作声明的状态码集合。上游 AiTaskClient 以 @MockitoBean 替换
 * （沿用 M2IntegrationTest 的替身模式），保证不依赖 ai-service 在线。
 * 数据：test-m2-seed.sql（cn-seed-1 会话 + task-seed-asr-1 转写草稿，与 M1/M3 种子互斥故独立上下文）。
 * 覆盖域：consultations、consultations/{id}/messages、confirmations、ai/tasks（GET/DELETE/SSE）、
 *         voice（asr/tts/voices/voices/default/previews/models）、care-plans。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4consult;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m2-seed.sql"
})
@AutoConfigureMockMvc
class M4ContractConsultTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

    /** 上游替身：未编程时默认 submit=QUEUED / get=FAILED(CAPABILITY_UNAVAILABLE) / cancel=CANCELLED。 */
    @MockitoBean
    private AiTaskClient aiClient;

    @BeforeEach
    void stubUpstream() {
        Mockito.reset(aiClient);
        Mockito.when(aiClient.submit(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenAnswer(inv -> accepted((String) inv.getArgument(1), (String) inv.getArgument(0)));
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> failed(inv.getArgument(0)));
        Mockito.when(aiClient.cancel(any(), any())).thenAnswer(inv ->
                new UpstreamTask(inv.getArgument(0), "CHAT", "CANCELLED", null, null, null, null,
                        "POLICY-v1", false, null, null, null, null, null));
        Mockito.when(aiClient.readiness()).thenReturn(null);
    }

    // ---------------------------------------------------------------- 基础设施

    /** 契约探针断言：实测状态码必须落在该操作契约声明的状态码集合内。 */
    private static void probe(String op, int actual, int... declared) {
        for (int d : declared) {
            if (d == actual) {
                return;
            }
        }
        throw new AssertionError("契约探针 " + op + " 实测 " + actual
                + " 不在契约声明集合 " + java.util.Arrays.toString(declared));
    }

    private static int st(MvcResult result) {
        return result.getResponse().getStatus();
    }

    private static String body(MvcResult result) throws java.io.UnsupportedEncodingException {
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    // ---------------------------------------------------------------- 上游替身（与 M2 同构）

    private static UpstreamTask accepted(String taskType, String userId) {
        return new UpstreamTask("up-" + UUID.randomUUID(), taskType, "QUEUED", "safety_check",
                "small-default", null, null, "POLICY-v1", false, null, null,
                Instant.now(), null, Instant.now().plusSeconds(120));
    }

    private static UpstreamTask failed(String taskId) {
        return new UpstreamTask(taskId, "CHAT", "FAILED", "safety_check", "small-default", null, null,
                "POLICY-v1", false, null,
                new UpstreamTask.UpstreamTaskError("CAPABILITY_UNAVAILABLE", "能力暂不可用", null, true),
                null, null, null);
    }

    private static UpstreamTask succeeded(String taskId, UpstreamTask.UpstreamTaskResult result) {
        return new UpstreamTask(taskId, "CHAT", "SUCCEEDED", "postprocess", "small-default", null, null,
                "POLICY-v1", false, result, null, null, Instant.now(), null);
    }

    private static UpstreamTask.UpstreamTaskResult carePlanResult(boolean refused, String refusalReason) {
        var om = new ObjectMapper();
        var suggestions = om.createArrayNode();
        if (!refused) {
            suggestions.add(om.createObjectNode()
                    .put("title", "睡前一小时远离屏幕")
                    .put("detail", "固定就寝时间，睡前一小时减少强光刺激，卧室保持安静与凉爽。"));
        }
        return new UpstreamTask.UpstreamTaskResult(
                null, null, null, null, null, null, refused, refusalReason, null, null,
                suggestions, "以上为生活方式与膳食参考，不构成处方、治疗方案或用药指导。");
    }

    // ---------------------------------------------------------------- consultations

    @Test
    void consultations域() throws Exception {
        probe("GET /api/v1/consultations", st(mockMvc.perform(get("/api/v1/consultations")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 503);

        // 创建：submit=QUEUED → 200；同键重放 → 200（契约 200,400,401,409,413,429,503）
        String key = "m4cc-consult-" + UUID.randomUUID();
        MvcResult created = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"契约探针症状描述\"}"))
                .andReturn();
        probe("POST /api/v1/consultations", st(created), 200, 400, 401, 409, 413, 429, 503);

        probe("POST /api/v1/consultations(同键重放)",
                st(mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"契约探针症状描述\"}"))
                .andReturn()), 200, 400, 401, 409, 413, 429, 503);

        probe("GET /api/v1/consultations/{consultationId}",
                st(mockMvc.perform(get("/api/v1/consultations/cn-seed-1")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);
        probe("GET /api/v1/consultations/{consultationId}(不存在/越权)",
                st(mockMvc.perform(get("/api/v1/consultations/cn-no-such")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);

        probe("POST /api/v1/consultations/{consultationId}/messages",
                st(mockMvc.perform(post("/api/v1/consultations/cn-seed-1/messages")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-msg-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"契约探针消息\"}"))
                .andReturn()), 200, 400, 401, 404, 409, 413, 429, 503);

        // 种子草稿 msg-draft-1（source_task_id=task-seed-asr-1）确认 → 200
        probe("POST /api/v1/consultations/{consultationId}/confirmations",
                st(mockMvc.perform(post("/api/v1/consultations/cn-seed-1/confirmations")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-conf-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"sourceTaskId\":\"task-seed-asr-1\",\"confirmedText\":\"胃胀三天了\"}"))
                .andReturn()), 200, 401, 404, 409, 422);

        // N1（2026-10-19 补齐）：拉取会话消息正文（旧→新升序，游标分页；不存在/越权 → 404）
        probe("GET /api/v1/consultations/{consultationId}/messages",
                st(mockMvc.perform(get("/api/v1/consultations/cn-seed-1/messages")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);
        probe("GET /api/v1/consultations/{consultationId}/messages(不存在/越权)",
                st(mockMvc.perform(get("/api/v1/consultations/cn-no-such/messages")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);
    }

    // ---------------------------------------------------------------- ai/tasks

    @Test
    void aiTasks域_查询与SSE与取消() throws Exception {
        // 建会话拿真实任务
        MvcResult created = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-task-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"契约探针任务域\"}"))
                .andReturn();
        String taskId = mapper.readTree(body(created)).path("data").path("task").path("taskId").asText("");
        org.assertj.core.api.Assertions.assertThat(taskId).isNotBlank();

        probe("GET /api/v1/ai/tasks/{taskId}", st(mockMvc.perform(get("/api/v1/ai/tasks/" + taskId)
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404, 503);
        probe("GET /api/v1/ai/tasks/{taskId}(不存在)",
                st(mockMvc.perform(get("/api/v1/ai/tasks/task-no-such")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404, 503);

        // SSE：增量通道挂起即 200（异步已启动），权威仍是 GET 单查
        MvcResult sse = mockMvc.perform(get("/api/v1/ai/tasks/" + taskId + "/events")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(request().asyncStarted())
                .andReturn();
        mockMvc.perform(asyncDispatch(sse)).andExpect(status().isOk());

        probe("DELETE /api/v1/ai/tasks/{taskId}", st(mockMvc.perform(delete("/api/v1/ai/tasks/" + taskId)
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);
    }

    // ---------------------------------------------------------------- voice

    @Test
    void voice域() throws Exception {
        // TTS：上游失败 → 503（契约声明 200,400,401,413,429,503,504）
        probe("POST /api/v1/voice/tts(上游失败)",
                st(mockMvc.perform(post("/api/v1/voice/tts")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-tts-fail-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"契约探针失败文本\"}"))
                .andReturn()), 200, 400, 401, 413, 429, 503, 504);

        // TTS：上游成功 → 200 短期签名 URL
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                new UpstreamTask.UpstreamTaskResult(null, null, "https://signed.local/tts/m4c.mp3",
                        null, null, null, false, null, null, null, null, null)));
        probe("POST /api/v1/voice/tts", st(mockMvc.perform(post("/api/v1/voice/tts")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-tts-ok-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"契约探针成功文本\"}"))
                .andReturn()), 200, 400, 401, 413, 429, 503, 504);

        probe("GET /api/v1/voice/voices", st(mockMvc.perform(get("/api/v1/voice/voices")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 503);
        probe("POST /api/v1/voice/voices", st(mockMvc.perform(post("/api/v1/voice/voices")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-voicepref-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"voiceId\":\"qwen3-female-1\",\"rate\":1.25,\"autoPlay\":false}"))
                .andReturn()), 200, 400, 401, 422);
        probe("GET /api/v1/voice/voices/default", st(mockMvc.perform(get("/api/v1/voice/voices/default")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 503);
        probe("POST /api/v1/voice/voices/{voiceId}/previews",
                st(mockMvc.perform(post("/api/v1/voice/voices/qwen3-female-1/previews")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404, 429);
        // 删除幂等防探测：未知音色也恒 200（契约 200,401）
        probe("DELETE /api/v1/voice/voices/{voiceId}",
                st(mockMvc.perform(delete("/api/v1/voice/voices/voice-no-such")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401);
        probe("GET /api/v1/voice/models", st(mockMvc.perform(get("/api/v1/voice/models")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401);

        // ASR：上游成功（转写文本）→ 200；Idempotency-Key 契约取自 header
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                new UpstreamTask.UpstreamTaskResult(null, "契约探针转写文本", null,
                        null, null, null, false, null, "zh-CN", false, null, null)));
        MockMultipartFile audio = new MockMultipartFile(
                "audio", "voice.wav", "audio/wav", "m4c-contract-audio".getBytes(StandardCharsets.UTF_8));
        probe("POST /api/v1/voice/asr", st(mockMvc.perform(multipart("/api/v1/voice/asr")
                        .file(audio)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-asr-" + UUID.randomUUID())
                        .param("durationMs", "3000"))
                .andReturn()), 200, 400, 401, 413, 429, 503, 504);
    }

    // ---------------------------------------------------------------- care-plans

    @Test
    void carePlans域() throws Exception {
        // 上游失败 → 503（契约 200,400,401,422,429,503）
        probe("POST /api/v1/care-plans(上游失败)",
                st(mockMvc.perform(post("/api/v1/care-plans")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-cp-fail-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"goal\":\"契约探针失败目标\"}"))
                .andReturn()), 200, 400, 401, 422, 429, 503);

        // 上游成功 → 200
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                carePlanResult(false, null)));
        probe("POST /api/v1/care-plans", st(mockMvc.perform(post("/api/v1/care-plans")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4cc-cp-ok-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"goal\":\"改善睡眠探针\",\"constraints\":[\"高血压\"]}"))
                .andReturn()), 200, 400, 401, 422, 429, 503);
    }
}
