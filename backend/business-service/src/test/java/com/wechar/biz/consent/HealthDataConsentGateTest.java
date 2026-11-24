package com.wechar.biz.consent;

import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.ai.AiTaskClient;
import com.wechar.biz.ai.dto.UpstreamTask;
import java.time.Instant;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 审计 F4-1 回归：健康数据单独同意的「未授权拦截 → 授予放行 → 撤回再拦截 → 版本过期拦截」。
 *
 * <p>本类显式打开 {@code app.consent.require-health-data=true}（itest 全局关闭，
 * 见 application-itest.yml 注释），证明门禁代码本身有效，而不是只靠配置关掉。</p>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:healthconsent;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m2-seed.sql",
        "app.auth.mode=header",
        "app.consent.require-health-data=true"
})
@AutoConfigureMockMvc
class HealthDataConsentGateTest {

    @Autowired
    private MockMvc mockMvc;

    @MockitoBean
    private AiTaskClient aiClient;

    @BeforeEach
    void stubUpstream() {
        Mockito.reset(aiClient);
        Mockito.when(aiClient.submit(any(), any(), any(), any(), any(), any(), any(), any()))
                .thenAnswer(inv -> new UpstreamTask("up-" + UUID.randomUUID(),
                        (String) inv.getArgument(1), "QUEUED", "safety_check", "small-default",
                        null, null, "POLICY-v1", false, null, null,
                        Instant.now(), null, Instant.now().plusSeconds(120)));
    }

    @Test
    void 未授权拦截_授予后放行_撤回后再拦截() throws Exception {
        String body = "{\"initialMessage\":\"最近胃胀三天\"}";

        // 1) 从未授予 → 422 CONSENT_REQUIRED，且不落任何会话（前置校验先于 persistence）
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "hc-consult-0001")
                        .content(body))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("CONSENT_REQUIRED"));

        // 2) 用户在前端单独授权页确认 → 记录 GRANTED（当前政策版本）
        mockMvc.perform(post("/api/v1/consents")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "hc-grant-0001")
                        .content("{\"purpose\":\"HEALTH_DATA_PROCESSING\",\"policyVersion\":\"v1.0\","
                                + "\"channel\":\"MINIPROGRAM\",\"scope\":[\"SYMPTOM_TEXT\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("GRANTED"))
                .andExpect(jsonPath("$.data.purpose").value("HEALTH_DATA_PROCESSING"));

        // 3) 重试同一次问诊 → 放行并建 CHAT 任务
        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "hc-consult-0002")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.task.taskType").value("CHAT"));

        // 4) 设置页撤回 → 立即生效，再发消息 422 CONSENT_WITHDRAWN
        mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "hc-withdraw-0001")
                        .content("{\"reason\":\"测试撤回\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("WITHDRAWN"));

        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "hc-consult-0003")
                        .content(body))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("CONSENT_WITHDRAWN"));

        // 5) 同意列表仍保留撤回记录（只追加不删除，供审计）
        mockMvc.perform(get("/api/v1/consents").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].purpose").value("HEALTH_DATA_PROCESSING"))
                .andExpect(jsonPath("$.data[0].status").value("WITHDRAWN"));
    }

    @Test
    void 授权版本与当前政策不一致_409要求重新同意() throws Exception {
        // 旧文本版本（v0.9）的授权不能继续用于当前 v1.0 的处理目的
        mockMvc.perform(post("/api/v1/consents")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "hc-grant-old-0001")
                        .content("{\"purpose\":\"HEALTH_DATA_PROCESSING\",\"policyVersion\":\"v0.9\","
                                + "\"channel\":\"MINIPROGRAM\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/consultations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "hc-consult-old-0001")
                        .content("{\"initialMessage\":\"头晕\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("CONSENT_VERSION_MISMATCH"));
    }
}
