package com.wechar.biz;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskClient;
import com.wechar.biz.ai.dto.UpstreamTask;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentMatchers;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * L1 急症漏报回归（2026-11-22 敌意审查）。
 *
 * <p>报告附录 A.1 的 9 类样本必须在**两条链路**都返回 emergency=true：
 * <ol>
 *   <li>{@code POST /api/v1/triage/emergency-checks}（导诊页即时检查）；</li>
 *   <li>在线问诊 safety（{@code POST /api/v1/consultations} 与 .../messages）——
 *       前端据此弹急救横幅 / 120 引导（consultation.js safety 分支）。</li>
 * </ol>
 *
 * <p>这些样本在原服务端 7 类词表下 8 条漏报（农药/婴儿/孕产/过敏/烧伤/自杀/外伤/急腹症）。
 * 本测试与 {@code TriageRedFlagParityTest} 共用同一份 golden 事实源语义；
 * 任何一条变红都意味着患者侧急救提示丢失，属 P0 阻断。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:emgtest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class EmergencySafetyIntegrationTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 报告附录 A.1 原文（9 类），顺序与原报告一致。 */
    private static final List<String> EMERGENCY_SAMPLES = List.of(
            "误服了农药怎么办",
            "孩子三个月大，发烧39度",
            "怀孕八个月，下面出血",
            "全身起大片皮疹，嘴唇肿，喘不上气",
            "大面积烫伤了，脸也烫到了",
            "不想活了，想结束生命",
            "突然头痛欲裂，脖子发硬",
            "出车祸了，腿被压住流血不止",
            "肚子硬得像板一样疼得受不了");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    /** 上游替身：本测试只验证急症 safety，不依赖 ai-service 在线（与 M4 同构）。 */
    @MockitoBean
    private AiTaskClient aiClient;

    @BeforeEach
    void stubUpstream() {
        Mockito.when(aiClient.submit(ArgumentMatchers.any(), ArgumentMatchers.any(),
                        ArgumentMatchers.any(), ArgumentMatchers.any(), ArgumentMatchers.any(),
                        ArgumentMatchers.any(), ArgumentMatchers.any(), ArgumentMatchers.any()))
                .thenAnswer(inv -> new UpstreamTask("up-" + UUID.randomUUID(),
                        (String) inv.getArgument(1), "QUEUED", "safety_check", "small-default",
                        null, null, "POLICY-v1", false, null, null, Instant.now(), null,
                        Instant.now().plusSeconds(120)));
    }

    @Test
    void 九类急症_导诊检查端点全部emergency() throws Exception {
        for (String text : EMERGENCY_SAMPLES) {
            mockMvc.perform(post("/api/v1/triage/emergency-checks")
                            .header("X-User-Id", "dev-user-1")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(MAPPER.writeValueAsString(Map.of("text", text))))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.emergency").value(true))
                    .andExpect(jsonPath("$.data.level").value("EMERGENCY"));
        }
    }

    @Test
    void 九类急症_创建问诊会话即返回safetyEmergency() throws Exception {
        for (String text : EMERGENCY_SAMPLES) {
            mockMvc.perform(post("/api/v1/consultations")
                            .header("X-User-Id", "dev-user-1")
                            .header("Idempotency-Key", "emg-create-" + UUID.randomUUID())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(MAPPER.writeValueAsString(Map.of("initialMessage", text))))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.safety.emergency").value(true))
                    .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"));
        }
    }

    /** B1：否定词修饰「诱因/原因」，这些是阳性主诉，不得被当成否认吞掉。 */
    private static final List<String> NEGATION_POSITIVES = List.of(
            "无诱因胸痛，还冒冷汗",
            "无原因胸痛伴大汗",
            "没原因胸痛，出冷汗",
            "无明显诱因胸痛，冷汗直流",
            "无任何诱因胸痛、恶心",
            "无原因意识模糊",
            "无诱因发热伴抽搐");

    @Test
    void 九类急症_追加消息链路每条样本独立session() throws Exception {
        // P3 L13：每条急症样本独立建会话，避免前一条急症的规则命中"搭便车"掩盖本条漏报。
        for (String text : EMERGENCY_SAMPLES) {
            String consultationId = createNeutralSession("dev-user-2");
            appendExpectEmergency(consultationId, "dev-user-2", text);
        }
    }

    @Test
    void 九类急症_同一会话连续追加仍逐条返回safetyEmergency() throws Exception {
        // 保留原复用会话用例作为补充：真实问诊中同一会话会持续追加，安全提示不能只在首条生效。
        String consultationId = createNeutralSession("dev-user-5");
        for (String text : EMERGENCY_SAMPLES) {
            appendExpectEmergency(consultationId, "dev-user-5", text);
        }
    }

    @Test
    void 否定语义阳性主诉_导诊与问诊均emergency() throws Exception {
        for (String text : NEGATION_POSITIVES) {
            mockMvc.perform(post("/api/v1/triage/emergency-checks")
                            .header("X-User-Id", "dev-user-6")
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(MAPPER.writeValueAsString(Map.of("text", text))))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.emergency").value(true));
            String consultationId = createNeutralSession("dev-user-6");
            appendExpectEmergency(consultationId, "dev-user-6", text);
        }
    }

    private String createNeutralSession(String userId) throws Exception {
        MvcResult created = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", userId)
                        .header("Idempotency-Key", "emg-session-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(MAPPER.writeValueAsString(Map.of("initialMessage", "最近两天有点乏力"))))
                .andExpect(status().isOk())
                .andReturn();
        String consultationId = MAPPER.readTree(created.getResponse().getContentAsString())
                .path("data").path("consultation").path("id").asText();
        org.assertj.core.api.Assertions.assertThat(consultationId).isNotBlank();
        return consultationId;
    }

    private void appendExpectEmergency(String consultationId, String userId, String text) throws Exception {
        mockMvc.perform(post("/api/v1/consultations/" + consultationId + "/messages")
                        .header("X-User-Id", userId)
                        .header("Idempotency-Key", "emg-msg-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(MAPPER.writeValueAsString(Map.of("content", text))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(true))
                .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"))
                .andExpect(jsonPath("$.data.safety.message", containsString("急诊科")));
    }

    @Test
    void 九类急症_幂等重放与轮询safetyFor同样返回emergency() throws Exception {
        for (String text : EMERGENCY_SAMPLES) {
            String key = "emg-replay-" + UUID.randomUUID();
            mockMvc.perform(post("/api/v1/consultations")
                            .header("X-User-Id", "dev-user-3")
                            .header("Idempotency-Key", key)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(MAPPER.writeValueAsString(Map.of("initialMessage", text))))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.safety.emergency").value(true))
                    .andExpect(jsonPath("$.data.safety.message", containsString("急诊科")));

            // 同 key 同体重放 → existing 分支走 safetyFor（修复前这里返回 false，急救横幅丢失）
            mockMvc.perform(post("/api/v1/consultations")
                            .header("X-User-Id", "dev-user-3")
                            .header("Idempotency-Key", key)
                            .contentType(MediaType.APPLICATION_JSON)
                            .content(MAPPER.writeValueAsString(Map.of("initialMessage", text))))
                    .andExpect(status().isOk())
                    .andExpect(jsonPath("$.data.safety.emergency").value(true))
                    .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"))
                    .andExpect(jsonPath("$.data.safety.provenance").value("RULE_RESULT"))
                    .andExpect(jsonPath("$.data.safety.message", containsString("急诊科")));
        }
    }

    @Test
    void AI快照判非急症时规则命中不得被降级() throws Exception {
        String text = "胸口压榨一样疼，还出汗";
        String key = "emg-ai-false-" + UUID.randomUUID();
        MvcResult created = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", "dev-user-4")
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(MAPPER.writeValueAsString(Map.of("initialMessage", text))))
                .andExpect(status().isOk())
                .andReturn();
        String consultationId = MAPPER.readTree(created.getResponse().getContentAsString())
                .path("data").path("consultation").path("id").asText();

        // 模拟 AI 任务成功但 result.safety 判 false（AI prompt 不是确定性兜底）
        jdbc.update("UPDATE ai_tasks SET status = 'SUCCEEDED', result_json = ? WHERE consultation_id = ?",
                "{\"safety\":{\"emergency\":false,\"level\":\"INFO\",\"message\":\"模型判断非急症\"}}",
                consultationId);

        mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", "dev-user-4")
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(MAPPER.writeValueAsString(Map.of("initialMessage", text))))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(true))
                .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"))
                .andExpect(jsonPath("$.data.safety.provenance").value("RULE_RESULT"))
                .andExpect(jsonPath("$.data.safety.message", containsString("急诊科")));
    }
}
