package com.wechar.biz;

import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.not;
import static org.hamcrest.Matchers.notNullValue;
import static org.hamcrest.Matchers.nullValue;
import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskClient;
import com.wechar.biz.ai.dto.UpstreamTask;
import com.wechar.biz.common.ApiException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * M2 关键规则集成测试（H2 MySQL 兼容模式，不依赖真实 MySQL 与运行中的 ai-service）：
 * 覆盖：
 *  - consultations：急症优先、幂等三态、生成失败不影响消息持久化（契约明文要求）、越权 404、游标分页；
 *  - confirmations：DRAFT → CONFIRMED、同键重放、异体 409、无草稿 404；
 *  - ai-task：断线查询权威语义（result 仅 SUCCEEDED、error 仅 FAILED）、终态幂等取消、SSE 不缓冲头；
 *  - voice：未知音色回退默认、删除幂等防探测、试听 404、能力状态如实（不 200+空对象）、
 *    TTS 成功/缓存重放/失败 503 降级、ASR 时长 400 与能力不可用 503、转写草稿闭环；
 *  - care-plans：成功/拒答/同键重放/异体 409、上游失败 503 结构化且不落库（非 200 空对象）。
 * 上游以 @MockitoBean 替换 AiTaskClient，按测试用例编程返回，保证不依赖 ai-service 在线。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m2test;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m2-seed.sql"
})
@AutoConfigureMockMvc
class M2IntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    @Autowired
    private ObjectMapper mapper;

    /** 上游替身：按用例编程；未编程时默认 submit=QUEUED / get=FAILED(CAPABILITY_UNAVAILABLE) / cancel=CANCELLED。 */
    @MockitoBean
    private AiTaskClient aiClient;

    @BeforeEach
    void stubUpstream() {
        Mockito.reset(aiClient);
        // 提交：受理 QUEUED（policyVersion 必填——V4 列 NOT NULL）
        Mockito.when(aiClient.submit(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenAnswer(inv -> accepted((String) inv.getArgument(1), (String) inv.getArgument(0)));
        // 查询：默认按上游能力不可用收口（D 侧 CHAT/CARE_PLAN 执行器未注册时的真实形态）
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> failed(inv.getArgument(0)));
        // 取消：终态回执（上游取消天然幂等）
        Mockito.when(aiClient.cancel(any(), any())).thenAnswer(inv ->
                new UpstreamTask(inv.getArgument(0), "CHAT", "CANCELLED", null, null, null, null,
                        "POLICY-v1", false, null, null, null, null, null));
        // 就绪探针默认不可达（能力入口须如实 unavailable，而非 200+空对象）
        Mockito.when(aiClient.readiness()).thenReturn(null);
    }

    // ---------------------------------------------------------------- 上游替身

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

    // ---------------------------------------------------------------- consultations

    @Test
    void 创建会话_急症优先_幂等三态_校验422() throws Exception {
        String body = "{\"initialMessage\":\"胸口压榨样疼痛，喘不上气\"}";

        // 缺 Idempotency-Key → 400
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 空 initialMessage → 422（字段级校验信封）
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0000")
                        .content("{\"initialMessage\":\"\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        // 契约外字段 → 400（严格反序列化，additionalProperties 拒绝）
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0000")
                        .content("{\"initialMessage\":\"胃胀\",\"hack\":1}"))
                .andExpect(status().isBadRequest());

        // 首次创建：200 + 急症优先 safety + task=QUEUED
        String created = mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0001")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "false"))
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.consultation.id").value(org.hamcrest.Matchers.startsWith("cn-")))
                .andExpect(jsonPath("$.data.consultation.status").value("ACTIVE"))
                .andExpect(jsonPath("$.data.task.taskId").value(org.hamcrest.Matchers.startsWith("task-")))
                .andExpect(jsonPath("$.data.task.status").value("QUEUED"))
                .andExpect(jsonPath("$.data.task.taskType").value("CHAT"))
                // 急症优先：本地红旗规则先行，不等模型
                .andExpect(jsonPath("$.data.safety.emergency").value(true))
                .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"))
                .andExpect(jsonPath("$.data.safety.provenance").value("RULE_RESULT"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String consultationId = mapper.readTree(created).path("data").path("consultation").path("id").asText();

        // 同键同体 → 200 重放，同一会话
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0001")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.consultation.id").value(consultationId));

        // 同键异体 → 409 IDEMPOTENCY_KEY_REUSE
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0001")
                        .content("{\"initialMessage\":\"今天有点胃胀\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));
    }

    @Test
    void 生成失败_会话与消息仍持久化_同键重试补建任务() throws Exception {
        String body = "{\"initialMessage\":\"胃里隐隐作痛三天了\"}";

        // 上游提交失败 → 结构化 503（不静默、不空 200）
        Mockito.when(aiClient.submit(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenThrow(new ApiException("AI_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                        "提交任务失败：AI 服务暂不可达", true, null));
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0002")
                        .content(body))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("AI_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(true));

        // 契约红线：生成失败不影响会话与首条消息的持久化（独立事务已先行提交）
        Integer consultationCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consultations WHERE user_id = 'u-dev-user-1' AND idempotency_key = 'm2-consult-0002'",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(consultationCount).isEqualTo(1);
        Integer messageCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consultation_messages WHERE content = '胃里隐隐作痛三天了'",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(messageCount).isEqualTo(1);

        // 上游恢复后同键重试 → 200 重放 + 补建任务（不产生第二个会话）
        // 注意：不能用 when(submit) 重打桩——when 会先真实调用，触发上一个 thenThrow 桩；
        // doAnswer 形式只登记桩体，不触发旧桩
        Mockito.doAnswer(inv -> accepted((String) inv.getArgument(1), (String) inv.getArgument(0)))
                .when(aiClient).submit(any(), any(), any(), any(), any(), any(), any(), any());
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0002")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.task.taskId").value(org.hamcrest.Matchers.startsWith("task-")))
                .andExpect(jsonPath("$.data.task.status").value("QUEUED"));
        Integer after = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consultations WHERE user_id = 'u-dev-user-1' AND idempotency_key = 'm2-consult-0002'",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(after).isEqualTo(1);
    }

    @Test
    void 发消息_幂等三态_越权404_生成失败仍持久化() throws Exception {
        // 先建会话（生成正常）
        String created = mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0003")
                        .content("{\"initialMessage\":\"反复反酸烧心\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String consultationId = mapper.readTree(created).path("data").path("consultation").path("id").asText();

        // 缺幂等键 → 400
        mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"content\":\"吃完饭更胀\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 上游提交失败 → 503，但消息已持久化（先落库再建任务）
        Mockito.when(aiClient.submit(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenThrow(new ApiException("AI_UNAVAILABLE", HttpStatus.SERVICE_UNAVAILABLE,
                        "提交任务失败：AI 服务暂不可达", true, null));
        mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-msg-key-0001")
                        .content("{\"content\":\"吃完饭更胀\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("AI_UNAVAILABLE"));
        Integer persisted = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consultation_messages WHERE idempotency_key = 'm2-msg-key-0001'",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(persisted).isEqualTo(1);

        // 上游恢复后同键重试 → 200 重放，同一消息 + 补建任务
        // 同上：doAnswer 形式重打桩，避免 when() 触发上一个 thenThrow 桩
        Mockito.doAnswer(inv -> accepted((String) inv.getArgument(1), (String) inv.getArgument(0)))
                .when(aiClient).submit(any(), any(), any(), any(), any(), any(), any(), any());
        String sent = mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-msg-key-0001")
                        .content("{\"content\":\"吃完饭更胀\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.message.role").value("user"))
                .andExpect(jsonPath("$.data.message.provenance").value("USER_INPUT"))
                .andExpect(jsonPath("$.data.task.status").value("QUEUED"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String messageId = mapper.readTree(sent).path("data").path("message").path("id").asText();

        // 同键异体 → 409
        mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-msg-key-0001")
                        .content("{\"content\":\"换成另一句话\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));

        // 他人会话发消息 → 404（不泄露存在性）
        mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/messages")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "m2-msg-key-0002")
                        .content("{\"content\":\"越权测试\"}"))
                .andExpect(status().isNotFound());

        // 会话详情：消息含本次发出内容；他人会话 404
        mockMvc.perform(get("/api/v1/consultations/" + consultationId)
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.consultation.id").value(consultationId))
                .andExpect(jsonPath("$.data.messages", hasSize(greaterThanOrEqualTo(2))))
                .andExpect(jsonPath("$.data.messages[*].id").value(org.hamcrest.Matchers.hasItem(messageId)));
        mockMvc.perform(get("/api/v1/consultations/" + consultationId)
                        .header("X-User-Id", "dev-user-2"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("CONSULTATION_NOT_FOUND"));
    }

    @Test
    void 会话列表_游标分页与非法cursor() throws Exception {
        // limit=1 满页 → meta.nextCursor 存在
        mockMvc.perform(get("/api/v1/consultations").param("limit", "1")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(1)))
                .andExpect(jsonPath("$.meta.nextCursor").value(notNullValue()));

        // 非法 cursor → 422（不给内部细节）
        mockMvc.perform(get("/api/v1/consultations").param("cursor", "!!!not-base64!!!")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        // cursor 超 256 字符 → 422
        mockMvc.perform(get("/api/v1/consultations").param("cursor", "x".repeat(257))
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    // ---------------------------------------------------------------- confirmations

    @Test
    void 确认转写_草稿到CONFIRMED_重放_异体409_无草稿404() throws Exception {
        // 首次确认（种子草稿 sourceTaskId=task-seed-asr-1）→ CONFIRMED，内容以用户核对文本为准
        String confirmed = mockMvc.perform(post("/api/v1/consultations/cn-seed-1/confirmations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-conf-key-0001")
                        .content("{\"sourceTaskId\":\"task-seed-asr-1\",\"confirmedText\":\"胃胀三天，饭后加重\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "false"))
                .andExpect(jsonPath("$.data.id").value("msg-draft-1"))
                .andExpect(jsonPath("$.data.generationStatus").value("CONFIRMED"))
                .andExpect(jsonPath("$.data.content").value("胃胀三天，饭后加重"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        org.assertj.core.api.Assertions.assertThat(confirmed).contains("\"generationStatus\":\"CONFIRMED\"");

        // 同键同体 → 200 重放
        mockMvc.perform(post("/api/v1/consultations/cn-seed-1/confirmations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-conf-key-0001")
                        .content("{\"sourceTaskId\":\"task-seed-asr-1\",\"confirmedText\":\"胃胀三天，饭后加重\"}"))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.generationStatus").value("CONFIRMED"));

        // 同来源不同载荷/键 → 409（已确认不能被再次改写）
        mockMvc.perform(post("/api/v1/consultations/cn-seed-1/confirmations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-conf-key-0002")
                        .content("{\"sourceTaskId\":\"task-seed-asr-1\",\"confirmedText\":\"换一句话\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("ALREADY_CONFIRMED"));

        // 无对应草稿 → 404
        mockMvc.perform(post("/api/v1/consultations/cn-seed-1/confirmations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-conf-key-0003")
                        .content("{\"sourceTaskId\":\"task-no-such\",\"confirmedText\":\"不存在的草稿\"}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("SOURCE_TASK_NOT_FOUND"));

        // 他人会话 → 404
        mockMvc.perform(post("/api/v1/consultations/cn-seed-1/confirmations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "m2-conf-key-0004")
                        .content("{\"sourceTaskId\":\"task-seed-asr-1\",\"confirmedText\":\"越权\"}"))
                .andExpect(status().isNotFound());
    }

    // ---------------------------------------------------------------- ai-task

    @Test
    void 任务查询_断线权威语义_result仅SUCCEEDED_error仅FAILED() throws Exception {
        // 上游 FAILED → GET 同步为 FAILED + 结构化 error，result 不出现
        String c1 = mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0004")
                        .content("{\"initialMessage\":\"早上起来头晕\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String task1 = mapper.readTree(c1).path("data").path("task").path("taskId").asText();

        mockMvc.perform(get("/api/v1/ai/tasks/" + task1).header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("FAILED"))
                .andExpect(jsonPath("$.data.error.code").value("CAPABILITY_UNAVAILABLE"))
                .andExpect(jsonPath("$.data.error.retryable").value(true))
                .andExpect(jsonPath("$.data.result").doesNotExist());

        // 上游 SUCCEEDED → result 出现、error 不出现
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                new UpstreamTask.UpstreamTaskResult(
                        "这是参考回复内容", null, null,
                        java.util.List.of(new UpstreamTask.UpstreamCitation(
                                "src-1", "中国居民膳食指南", "2022", null, 0.8)),
                        null, "AI_GENERATED", false, null, null, null, null, null)));
        String c2 = mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0005")
                        .content("{\"initialMessage\":\"最近夜里出汗\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String task2 = mapper.readTree(c2).path("data").path("task").path("taskId").asText();

        mockMvc.perform(get("/api/v1/ai/tasks/" + task2).header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("SUCCEEDED"))
                .andExpect(jsonPath("$.data.result.text").value("这是参考回复内容"))
                .andExpect(jsonPath("$.data.result.citations[0].sourceId").value("src-1"))
                .andExpect(jsonPath("$.data.error").doesNotExist());

        // 他人任务 → 404（不泄露存在性）
        mockMvc.perform(get("/api/v1/ai/tasks/" + task1).header("X-User-Id", "dev-user-2"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("TASK_NOT_FOUND"));

        // taskId 超 64 字符 → 422
        mockMvc.perform(get("/api/v1/ai/tasks/" + "x".repeat(65))
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isUnprocessableEntity());
    }

    @Test
    void 任务取消_幂等同一终态() throws Exception {
        String created = mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0006")
                        .content("{\"initialMessage\":\"咳嗽两周了\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String taskId = mapper.readTree(created).path("data").path("task").path("taskId").asText();

        // 首次取消 → 200 CANCELLED
        mockMvc.perform(delete("/api/v1/ai/tasks/" + taskId).header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CANCELLED"));

        // 重复取消 → 200 同一终态（幂等，不再调用上游）
        mockMvc.perform(delete("/api/v1/ai/tasks/" + taskId).header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CANCELLED"));
        Mockito.verify(aiClient, Mockito.times(1)).cancel(any(), any());

        // 终态任务 GET：仍为同一终态（断线恢复以 GET 为权威）；
        // 契约 result 仅 SUCCEEDED 出现（NON_NULL 序列化），故断言字段缺失而非 null
        mockMvc.perform(get("/api/v1/ai/tasks/" + taskId).header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CANCELLED"))
                .andExpect(jsonPath("$.data.result").doesNotExist())
                .andExpect(jsonPath("$.data.error").doesNotExist());
    }

    @Test
    void SSE事件流_不缓冲头_异步流式() throws Exception {
        String created = mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0007")
                        .content("{\"initialMessage\":\"最近总感觉口干\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String taskId = mapper.readTree(created).path("data").path("task").path("taskId").asText();

        // 上游立即终态，SSE 短路收口（accepted → status → error/completed）
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> failed(inv.getArgument(0)));

        MvcResult sse = mockMvc.perform(get("/api/v1/ai/tasks/" + taskId + "/events")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(header().string("Cache-Control", "no-store"))
                .andExpect(header().string("X-Accel-Buffering", "no"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .request().asyncStarted())
                .andReturn();

        // 断线恢复权威仍是 GET 单查（契约要求）
        mockMvc.perform(get("/api/v1/ai/tasks/" + taskId).header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("FAILED"));

        try {
            // 等待 SSE 工作线程收口；MockMvc 对 SseEmitter 不一定回填 asyncResult，
            // 头与 asyncStarted 已在上面断言，超时/无结果不影响本用例结论
            sse.getAsyncResult(5000);
        } catch (Exception ignore) {
            // 收口异常不作为本用例失败依据（权威语义由随后的 GET 断言覆盖）
        }
    }

    // ---------------------------------------------------------------- voice

    @Test
    void 音色列表_默认音色_未知音色回退默认_删除幂等_试听404() throws Exception {
        mockMvc.perform(get("/api/v1/voice/voices").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(greaterThanOrEqualTo(2))))
                .andExpect(jsonPath("$.data[0].id").value(notNullValue()))
                .andExpect(jsonPath("$.data[0].isCustom").value(false));

        mockMvc.perform(get("/api/v1/voice/voices/default").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("qwen3-female-1"))
                .andExpect(jsonPath("$.data.isDefault").value(true));

        // 未知音色保存偏好 → 200 回退默认（客户端容忍未知值的对端保障），偏好落库
        mockMvc.perform(post("/api/v1/voice/voices")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"voiceId\":\"no-such-voice\",\"rate\":1.25,\"autoPlay\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("qwen3-female-1"));
        String stored = jdbc.queryForObject(
                "SELECT voice_id FROM voice_preferences WHERE user_id = 'u-dev-user-1'", String.class);
        org.assertj.core.api.Assertions.assertThat(stored).isEqualTo("qwen3-female-1");

        // 未知音色试听 → 404（不 200+空对象）
        mockMvc.perform(post("/api/v1/voice/voices/no-such-voice/previews")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("VOICE_NOT_FOUND"));

        // 删除不存在的自定义音色 → 200 deleted=true（幂等防探测）
        mockMvc.perform(delete("/api/v1/voice/voices/not-mine-at-all")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.deleted").value(true));
        // 删除内置音色 ID 同样幂等成功（只删当前用户的自定义音色）
        mockMvc.perform(delete("/api/v1/voice/voices/qwen3-female-1")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.deleted").value(true));
        mockMvc.perform(get("/api/v1/voice/voices/default").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("qwen3-female-1"));
    }

    @Test
    void 模型能力状态_探针不可达时如实unavailable() throws Exception {
        // readiness 返回 null（不可达）→ 每项都给 status + detail，不 200+空对象
        mockMvc.perform(get("/api/v1/voice/models").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(4)))
                .andExpect(jsonPath("$.data[0].status").value("unavailable"))
                .andExpect(jsonPath("$.data[0].detail").value(notNullValue()));

        // 就绪：asr loaded + tts available → 对应能力 available（如实映射）
        Mockito.when(aiClient.readiness()).thenReturn(
                new com.wechar.biz.ai.dto.UpstreamReadiness("ok",
                        java.util.List.of(
                                new com.wechar.biz.ai.dto.UpstreamReadiness.Dependency(
                                        "asr_model", "available", "本地 ASR 权重已就绪", 12),
                                new com.wechar.biz.ai.dto.UpstreamReadiness.Dependency(
                                        "tts_provider", "available", "TTS 引擎已配置", 8)),
                        java.util.List.of(
                                new com.wechar.biz.ai.dto.UpstreamReadiness.Model(
                                        "asr", "qwen3-asr-0.6b", "loaded", true),
                                new com.wechar.biz.ai.dto.UpstreamReadiness.Model(
                                        "small-default", "chat-small-default", "loaded", true),
                                new com.wechar.biz.ai.dto.UpstreamReadiness.Model(
                                        "embedding", "embedding", "loaded", false))));
        mockMvc.perform(get("/api/v1/voice/models").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].status").value("available"))
                .andExpect(jsonPath("$.data[1].status").value("available"));
    }

    @Test
    void TTS_成功_缓存重放cached_失败503降级() throws Exception {
        String body = "{\"text\":\"您的复查建议已生成\",\"voiceId\":\"qwen3-female-1\"}";

        // 缺 Idempotency-Key → 400（契约 required:true，先于业务执行拒绝）
        mockMvc.perform(post("/api/v1/voice/tts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 上游合成成功 → 短期签名 URL，不内联字节
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                new UpstreamTask.UpstreamTaskResult(null, null, "https://signed.local/tts/a.mp3",
                        null, null, null, false, null, null, null, null, null)));
        mockMvc.perform(post("/api/v1/voice/tts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-tts-key-0001")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.audioUrl").value("https://signed.local/tts/a.mp3"))
                .andExpect(jsonPath("$.data.mime").value("audio/mpeg"))
                .andExpect(jsonPath("$.data.cached").value(false))
                .andExpect(jsonPath("$.data.voiceId").value("qwen3-female-1"));

        // 同文本同音色 → 缓存命中，cached=true（上游不再被查询）
        Mockito.clearInvocations(aiClient);
        mockMvc.perform(post("/api/v1/voice/tts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-tts-key-0002")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.cached").value(true));
        Mockito.verify(aiClient, Mockito.times(0)).get(any());

        // 失败 → 503 TTS_UNAVAILABLE 结构化降级（页面保留文字，不 200 空对象）
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> failed(inv.getArgument(0)));
        mockMvc.perform(post("/api/v1/voice/tts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-tts-key-0003")
                        .content("{\"text\":\"需要另一段不同文本做失败用例\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("TTS_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(true));

        // 空文本 → 422（字段校验先行，不触发上游）
        mockMvc.perform(post("/api/v1/voice/tts")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-tts-key-0004")
                        .content("{\"text\":\"\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    @Test
    void ASR_时长校验400_能力不可用503_识别成功落DRAFT草稿() throws Exception {
        MockMultipartFile audio = new MockMultipartFile(
                "audio", "voice.wav", "audio/wav", "fake-audio-bytes".getBytes(StandardCharsets.UTF_8));

        // 缺 Idempotency-Key header → 400（契约 in:header required:true；08G §12 N-3 反例）
        mockMvc.perform(multipart("/api/v1/voice/asr")
                        .file(audio)
                        .param("durationMs", "3000")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 时长超限 → 400（提前拒绝，不送上游）
        mockMvc.perform(multipart("/api/v1/voice/asr")
                        .file(audio)
                        .header("Idempotency-Key", "m2-asr-key-0001")
                        .param("durationMs", "60001")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        Mockito.verify(aiClient, Mockito.times(0)).submit(any(), any(), any(), any(), any(), any(), any(), any());

        // 空音频 → 400
        MockMultipartFile empty = new MockMultipartFile("audio", "e.wav", "audio/wav", new byte[0]);
        mockMvc.perform(multipart("/api/v1/voice/asr").file(empty)
                        .header("Idempotency-Key", "m2-asr-key-0002")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isBadRequest());

        // 上游能力不可用 → 503 CAPABILITY_UNAVAILABLE（改用文字输入的提示，不静默）
        mockMvc.perform(multipart("/api/v1/voice/asr")
                        .file(audio)
                        .header("Idempotency-Key", "m2-asr-key-0003")
                        .param("durationMs", "3000")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("CAPABILITY_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(true));

        // 识别成功（带会话）→ 转写文本 + requiresConfirmation 恒 true + 落 DRAFT 草稿
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                new UpstreamTask.UpstreamTaskResult(null, "胃胀三天，饭后明显", null,
                        null, null, null, false, null, "zh-CN", false, null, null)));
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-consult-0008")
                        .content("{\"initialMessage\":\"帮我记一下症状\",\"inputMode\":\"VOICE\"}"))
                .andExpect(status().isOk());
        Integer consultCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consultations WHERE user_id = 'u-dev-user-1' AND idempotency_key = 'm2-consult-0008'",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(consultCount).isEqualTo(1);
        String consultationId = jdbc.queryForObject(
                "SELECT id FROM consultations WHERE user_id = 'u-dev-user-1' AND idempotency_key = 'm2-consult-0008'",
                String.class);

        // 正例：幂等键取自 header（08G §12 N-3；仅 header、无 query 参数，按契约调用不再 400）
        String asr = mockMvc.perform(multipart("/api/v1/voice/asr")
                        .file(audio)
                        .header("Idempotency-Key", "m2-asr-key-0004")
                        .param("durationMs", "3000")
                        .param("consultationId", consultationId)
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.text").value("胃胀三天，饭后明显"))
                .andExpect(jsonPath("$.data.requiresConfirmation").value(true))
                .andExpect(jsonPath("$.data.hasTimestamps").value(false))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        org.assertj.core.api.Assertions.assertThat(asr).doesNotContain("inputRef");

        // DRAFT 草稿已落库：未确认不得据此生成结论
        String draftStatus = jdbc.queryForObject(
                "SELECT generation_status FROM consultation_messages "
                        + "WHERE consultation_id = ? AND content_type = 'VOICE_TRANSCRIPT' ORDER BY created_at DESC LIMIT 1",
                String.class, consultationId);
        org.assertj.core.api.Assertions.assertThat(draftStatus).isEqualTo("DRAFT");

        // 客户端用草稿消息 ID 作为 sourceTaskId 确认（契约 AsrResult 不暴露任务 ID）
        String draftId = jdbc.queryForObject(
                "SELECT id FROM consultation_messages "
                        + "WHERE consultation_id = ? AND content_type = 'VOICE_TRANSCRIPT' ORDER BY created_at DESC LIMIT 1",
                String.class, consultationId);
        mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/confirmations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-conf-key-0010")
                        .content("{\"sourceTaskId\":\"" + draftId + "\",\"confirmedText\":\"胃胀三天，饭后明显\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.generationStatus").value("CONFIRMED"))
                .andExpect(jsonPath("$.data.id").value(draftId));
    }

    // ---------------------------------------------------------------- care-plans

    @Test
    void 照护建议_成功_拒答_同键重放_异体409() throws Exception {
        String body = "{\"goal\":\"改善睡眠\",\"constraints\":[\"高血压\"]}";

        // 上游返回建议 → suggestions + limitations 边界声明 + 每条带 provenance
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                carePlanResult(false, null)));
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-cp-key-0001")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "false"))
                .andExpect(jsonPath("$.data.suggestions", hasSize(greaterThanOrEqualTo(1))))
                .andExpect(jsonPath("$.data.suggestions[0].title").value(notNullValue()))
                .andExpect(jsonPath("$.data.suggestions[0].provenance").value("AI_GENERATED"))
                .andExpect(jsonPath("$.data.refused").value(false))
                // 红线：不构成处方
                .andExpect(jsonPath("$.data.limitations").value(org.hamcrest.Matchers.containsString("不构成处方")));

        // 同键同体 → 200 落库重放（不再打上游）
        Mockito.clearInvocations(aiClient);
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-cp-key-0001")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.suggestions", hasSize(greaterThanOrEqualTo(1))));
        Mockito.verify(aiClient, Mockito.times(0)).submit(any(), any(), any(), any(), any(), any(), any(), any());

        // 同键异体 → 409
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-cp-key-0001")
                        .content("{\"goal\":\"另一个目标\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));

        // 上游结构化拒答 → refused + refusalReason，suggestions 空数组（非 200 空对象）
        Mockito.when(aiClient.get(any())).thenAnswer(inv -> succeeded((String) inv.getArgument(0),
                carePlanResult(true, "当前证据不足，暂无法给出针对性建议")));
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-cp-key-0002")
                        .content("{\"goal\":\"缓解关节疼痛\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.refused").value(true))
                .andExpect(jsonPath("$.data.refusalReason").value("当前证据不足，暂无法给出针对性建议"))
                .andExpect(jsonPath("$.data.suggestions", hasSize(0)))
                .andExpect(jsonPath("$.data.limitations").value(org.hamcrest.Matchers.containsString("不构成处方")));
    }

    @Test
    void 照护建议_上游失败_503结构化且不落库() throws Exception {
        // 上游任务失败 → CARE_PLAN_UNAVAILABLE 503（可重试），不伪装成 200 拒答/空对象
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-cp-key-0003")
                        .content("{\"goal\":\"控制体重\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("CARE_PLAN_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(true))
                .andExpect(jsonPath("$.requestId").value(notNullValue()));

        // 同事务回滚：失败不留 PENDING 残行（重试即重新生成，不产生半成品）
        Integer rows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM care_plan_requests WHERE idempotency_key = 'm2-cp-key-0003'",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(rows).isZero();

        // 缺幂等键 → 400；空 goal → 422
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"goal\":\"控制体重\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));
        mockMvc.perform(post("/api/v1/care-plans")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m2-cp-key-0004")
                        .content("{\"goal\":\"\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    /** 构造 CARE_PLAN 上游结果（suggestions/limitations 为扩展字段，须经 UpstreamTaskResult 保留）。 */
    private static UpstreamTask.UpstreamTaskResult carePlanResult(boolean refused, String refusalReason) {
        try {
            com.fasterxml.jackson.databind.ObjectMapper om = new com.fasterxml.jackson.databind.ObjectMapper();
            com.fasterxml.jackson.databind.JsonNode suggestions;
            if (refused) {
                suggestions = om.createArrayNode();
            } else {
                suggestions = om.createArrayNode().add(om.createObjectNode()
                        .put("title", "睡前一小时远离屏幕")
                        .put("detail", "固定就寝时间，睡前一小时减少强光刺激，卧室保持安静与凉爽。"));
            }
            return new UpstreamTask.UpstreamTaskResult(
                    null, null, null, null, null, null, refused, refusalReason, null, null,
                    suggestions, "以上为生活方式与膳食参考，不构成处方、治疗方案或用药指导。");
        } catch (RuntimeException e) {
            throw new IllegalStateException(e);
        }
    }
}