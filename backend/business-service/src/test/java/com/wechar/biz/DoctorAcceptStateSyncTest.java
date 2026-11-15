package com.wechar.biz;

import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
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
import org.mockito.Mockito;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 接诊状态同步端到端测试（2026-10-24：医患双侧「待接诊 → 正在接诊」一致）。
 *
 * 背景：原 accepting 判定取「末条消息角色」，患者再发一句就翻回「待接诊」；
 * 且医生点「接诊」只写 consultations.doctor_id、不产生消息，患者端永远不会变「正在接诊」。
 *
 * 断言链路（真实 Controller/Service/SQL，AI 上游替身）：
 *   ① 患者指定医生发起（doctorId）→ 会话已归属但 accepting=false（待接诊）；
 *   ② 医生列表同上口径（assignedDoctorId 非空 + accepting=false）；
 *   ③ 医生 accept → 200，消息流出现一条 role=system_notice（「XX 已接诊」）；
 *   ④ 患者详情 accepting=true（正在接诊）；
 *   ⑤ 患者随后再发消息 → accepting 仍为 true（不翻转：接诊是会话级事实）；
 *   ⑥ 重复 accept → 幂等 200，且 system_notice 不重复写入；
 *   ⑦ 未指定医生的会话（患者端 AI 助手）→ 不进医生工作台、直读 404
 *      （2026-11-15 口径修正：AI 问答不再同步给医生）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:acceptsync;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class DoctorAcceptStateSyncTest {

    private static final String USER_DOCTOR = "dev-user-2";
    private static final String USER_PATIENT = "dev-user-1";
    private static final String DOCTOR_ID = "doc-gastro-1";

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

    /** 患者创建咨询；doctorIdToUse 为 null 时进认领池 */
    private String createConsultation(String doctorIdToUse) throws Exception {
        String bodyText = doctorIdToUse == null
                ? "{\"initialMessage\":\"嗓子疼三天，伴有低烧，想问问该挂什么科。\"}"
                : "{\"initialMessage\":\"嗓子疼三天，伴有低烧，想问问该挂什么科。\",\"doctorId\":\""
                        + doctorIdToUse + "\"}";
        MvcResult res = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "acc-create-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bodyText))
                .andExpect(status().isOk())
                .andReturn();
        return json(res).path("data").path("consultation").path("id").asText();
    }

    private JsonNode patientDetail(String cid) throws Exception {
        MvcResult res = mockMvc.perform(get("/api/v1/consultations/" + cid)
                        .header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andReturn();
        return json(res).path("data").path("consultation");
    }

    private JsonNode doctorListItem(String cid) throws Exception {
        MvcResult res = mockMvc.perform(get("/api/v1/doctor/consultations?limit=50")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        for (JsonNode item : json(res).path("data")) {
            if (cid.equals(item.path("id").asText())) {
                return item;
            }
        }
        return null;
    }

    private JsonNode doctorMessages(String cid) throws Exception {
        MvcResult res = mockMvc.perform(get("/api/v1/doctor/consultations/" + cid + "/messages?limit=50")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        return json(res).path("data");
    }

    private void accept(String cid) throws Exception {
        mockMvc.perform(post("/api/v1/doctor/consultations/" + cid + "/accept")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "acc-accept-" + UUID.randomUUID()))
                .andExpect(status().isOk());
    }

    private long countRole(JsonNode messages, String role) {
        long n = 0;
        for (JsonNode m : messages) {
            if (role.equals(m.path("role").asText())) {
                n++;
            }
        }
        return n;
    }

    @Test
    void 指定医生会话_接诊即同步正在接诊_且不因患者再发言翻转() throws Exception {
        String cid = createConsultation(DOCTOR_ID);

        // ① 患者侧：已归属医生，但尚未接诊
        JsonNode detail = patientDetail(cid);
        Assertions.assertFalse(detail.path("accepting").asBoolean(),
                "医生尚未接诊时 accepting 必须为 false（不能用「已有归属」冒充接诊）");

        // ② 医生侧列表同一口径
        JsonNode item = doctorListItem(cid);
        Assertions.assertNotNull(item, "医生列表应包含指定给自己的会话");
        Assertions.assertEquals(DOCTOR_ID, item.path("assignedDoctorId").asText());
        Assertions.assertFalse(item.path("accepting").asBoolean(), "列表 accepting 应与患者端同源");

        // ③ 接诊 → 写系统提示
        accept(cid);
        JsonNode msgs = doctorMessages(cid);
        Assertions.assertEquals(1, countRole(msgs, "system_notice"),
                "接诊应写入一条 system_notice（双方可见的系统提示）");

        // ④ 患者侧立刻变「正在接诊」
        JsonNode afterAccept = patientDetail(cid);
        Assertions.assertTrue(afterAccept.path("accepting").asBoolean(),
                "接诊后患者端 accepting 必须为 true；实际详情=" + afterAccept);

        // ⑤ 患者再发一句 → 状态不回退（原实现按末条消息角色判定会翻转）
        mockMvc.perform(post("/api/v1/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "acc-msg-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"补充：晚上咳嗽更明显。\"}"))
                .andExpect(status().isOk());
        Assertions.assertTrue(patientDetail(cid).path("accepting").asBoolean(),
                "患者再次发言后仍应保持「正在接诊」");

        // ⑥ 重复接诊幂等：不重复写系统提示
        accept(cid);
        Assertions.assertEquals(1, countRole(doctorMessages(cid), "system_notice"),
                "重复接诊不得重复写系统提示");
    }

    @Test
    void 未指定医生的会话_不进医生工作台且不可越权读取() throws Exception {
        // 2026-11-15 口径修正：未指定医生的会话就是患者端 AI 助手的会话，
        // 原「认领池」把 AI 问答整体推到医生眼前（医生端能看到一整屏 AI 对话、还能接诊），
        // 现改为医生端只列 doctor_id=本人 的会话。本用例锁死这条边界。
        String cid = createConsultation(null);

        Assertions.assertNull(doctorListItem(cid),
                "未指定医生的会话不得出现在医生工作台列表（AI 问答不同步给医生）");

        // 列表不显示后，深链/旧入口也必须读不到：归属校验 → 404
        mockMvc.perform(get("/api/v1/doctor/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isNotFound());

        // 患者侧照旧：AI 会话正常存在，accepting 为空（与医生无关）
        Assertions.assertFalse(patientDetail(cid).path("accepting").asBoolean(),
                "AI 会话不存在承担接诊的医生，accepting 必须为 false");
    }
}
