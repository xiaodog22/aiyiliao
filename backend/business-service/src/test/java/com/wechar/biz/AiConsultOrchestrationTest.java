package com.wechar.biz;

import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskClient;
import com.wechar.biz.ai.dto.UpstreamTask;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.Assertions;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * AI 问诊编排测试（2026-10-24：AI 问诊接入后端真实模型链路）。
 *
 * 背景：此前 AI 问诊页用本地关键词引擎直接出科室，**没有**调用任何 AI 服务；
 * 且业务侧建 CHAT 任务时只把「用户这一句」当 inputInline，模型看不到前文，
 * 因此问不出「先收集信息、再判断」的效果。
 *
 * 本测试锁死两条编排契约（上游模型以替身捕获请求体，断言**真实提交内容**）：
 *   ① CHAT 任务的 inputInline 必须是**多轮上下文**（患者：/医生助手：逐行），不是单句；
 *   ② TRIAGE 任务的 inputInline 必须是**患者发言聚合**（只含患者侧，用「；」连接），
 *      任务类型为 TRIAGE，供前端拿 departmentName + confidence 出分诊卡。
 * 另含越权保护：他人会话触发分诊 → 404。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:aiorch;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class AiConsultOrchestrationTest {

    private static final String USER_PATIENT = "dev-user-1";
    private static final String USER_OTHER = "dev-user-2";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

    @MockitoBean
    private AiTaskClient aiClient;

    @BeforeEach
    void stubUpstream() {
        Mockito.reset(aiClient);
        Mockito.when(aiClient.submit(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenAnswer(inv -> new UpstreamTask("up-" + UUID.randomUUID(), "CHAT", "QUEUED",
                        "safety_check", "small-default", null, null, "POLICY-v1", false,
                        null, null, Instant.now(), null, Instant.now().plusSeconds(120)));
        Mockito.when(aiClient.get(any())).thenAnswer(inv ->
                new UpstreamTask(inv.getArgument(0), "CHAT", "FAILED", "safety_check", "small-default",
                        null, null, "POLICY-v1", false, null,
                        new UpstreamTask.UpstreamTaskError("CAPABILITY_UNAVAILABLE", "能力暂不可用", null, true),
                        null, null, null));
        Mockito.when(aiClient.readiness()).thenReturn(null);
    }

    private JsonNode json(MvcResult result) throws Exception {
        return mapper.readTree(result.getResponse().getContentAsString(StandardCharsets.UTF_8));
    }

    /** 捕获最近一次 submit 的 (taskType, inputInline) */
    private String[] captureSubmit() {
        ArgumentCaptor<String> typeCap = ArgumentCaptor.forClass(String.class);
        ArgumentCaptor<String> inputCap = ArgumentCaptor.forClass(String.class);
        Mockito.verify(aiClient).submit(any(), typeCap.capture(), any(), inputCap.capture(),
                any(), any(), any(), any());
        return new String[] {typeCap.getValue(), inputCap.getValue()};
    }

    private String createConsultation(String text) throws Exception {
        Mockito.clearInvocations(aiClient);
        MvcResult res = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "aiorch-create-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"" + text + "\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return json(res).path("data").path("consultation").path("id").asText();
    }

    @Test
    void Chat任务携带多轮上下文_分诊任务只聚合患者发言() throws Exception {
        // ① 首条消息：CHAT 任务 inputInline 就是这一句（带「患者：」前缀）
        String cid = createConsultation("嗓子疼三天了");
        String[] first = captureSubmit();
        Assertions.assertEquals("CHAT", first[0], "建会话应提交 CHAT 任务");
        Assertions.assertEquals("患者：嗓子疼三天了", first[1],
                "首轮上下文应只含这一句患者发言；实际=" + first[1]);

        // ② 第二轮：inputInline 必须带上第一句 —— 这是「先收集信息」的前提
        Mockito.clearInvocations(aiClient);
        mockMvc.perform(post("/api/v1/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "aiorch-msg-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"吞东西时更疼，没有发烧\"}"))
                .andExpect(status().isOk());
        String[] second = captureSubmit();
        Assertions.assertEquals("CHAT", second[0]);
        Assertions.assertTrue(second[1].contains("患者：嗓子疼三天了"),
                "第二轮上下文必须包含第一轮发言；实际=" + second[1]);
        Assertions.assertTrue(second[1].contains("患者：吞东西时更疼，没有发烧"),
                "第二轮上下文必须包含本轮发言；实际=" + second[1]);

        // ③ AI 分诊：任务类型 TRIAGE，症状文本 = 患者发言按时间聚合（只含患者侧）
        Mockito.clearInvocations(aiClient);
        MvcResult triageRes = mockMvc.perform(post("/api/v1/consultations/" + cid + "/triage")
                        .header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode taskData = json(triageRes).path("data");
        Assertions.assertTrue(taskData.path("taskId").asText().startsWith("task-"),
                "分诊应返回可轮询的 taskId");
        String[] triage = captureSubmit();
        Assertions.assertEquals("TRIAGE", triage[0], "分诊必须提交 TRIAGE 任务（由远端模型给科室+置信度）");
        Assertions.assertEquals("嗓子疼三天了；吞东西时更疼，没有发烧", triage[1],
                "症状聚合应只含患者发言且按时间用「；」连接；实际=" + triage[1]);
    }

    @Test
    void 他人会话触发分诊_返回404防探测() throws Exception {
        String cid = createConsultation("最近饭后胃胀");
        mockMvc.perform(post("/api/v1/consultations/" + cid + "/triage")
                        .header("X-User-Id", USER_OTHER))
                .andExpect(status().isNotFound());
    }
}
