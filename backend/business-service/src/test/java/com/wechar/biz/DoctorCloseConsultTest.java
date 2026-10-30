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
 * 结束问诊端到端测试（2026-10-24：医生工作站收口按钮）。
 *
 * 背景：会话只进不出 —— 医生处理完无法收尾，患者端也就一直停在「正在接诊」，
 * 且医生列表永远堆着已处理完的会话。
 *
 * 断言链路（真实 Controller/Service/SQL，AI 上游替身）：
 *   ① 归属医生结束 → 200，data.status=CLOSED；
 *   ② 患者详情 status=CLOSED（客户端据此锁输入）；
 *   ③ 会话内新增一条 system_notice（「医生已结束本次问诊」），双方可见；
 *   ④ 医生列表不再包含该会话（listByDoctor 只查 ACTIVE）；
 *   ⑤ 患者再发消息 → 409（不会产生孤儿消息）；
 *   ⑥ 非本人结束 → 404（不泄露存在性）；重复结束 → 409；缺 Idempotency-Key → 400。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:closeconsult;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class DoctorCloseConsultTest {

    private static final String USER_DOCTOR = "dev-user-2";     // 绑定 doc-gastro-1
    private static final String USER_PATIENT = "dev-user-1";
    private static final String DOCTOR_ID = "doc-gastro-1";
    // doc-gastro-2 未绑定登录账号（user_id IS NULL）：指定它发起会话应 404 DOCTOR_NOT_FOUND

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

    private String createConsultation(String doctorIdToUse) throws Exception {
        // doctorIdToUse=null → 进认领池（未归属任何医生）
        String bodyText = doctorIdToUse == null
                ? "{\"initialMessage\":\"嗓子疼三天，伴有低烧，想问问该挂什么科。\"}"
                : "{\"initialMessage\":\"嗓子疼三天，伴有低烧，想问问该挂什么科。\",\"doctorId\":\""
                        + doctorIdToUse + "\"}";
        MvcResult res = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "close-create-" + UUID.randomUUID())
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

    private JsonNode doctorMessages(String cid) throws Exception {
        MvcResult res = mockMvc.perform(get("/api/v1/doctor/consultations/" + cid + "/messages?limit=50")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        return json(res).path("data");
    }

    private boolean inDoctorList(String cid) throws Exception {
        MvcResult res = mockMvc.perform(get("/api/v1/doctor/consultations?limit=50")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        for (JsonNode item : json(res).path("data")) {
            if (cid.equals(item.path("id").asText())) {
                return true;
            }
        }
        return false;
    }

    private void accept(String cid) throws Exception {
        mockMvc.perform(post("/api/v1/doctor/consultations/" + cid + "/accept")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "close-accept-" + UUID.randomUUID()))
                .andExpect(status().isOk());
    }

    private MvcResult close(String cid, String key) throws Exception {
        var req = post("/api/v1/doctor/consultations/" + cid + "/close")
                .header("X-User-Id", USER_DOCTOR);
        if (key != null) {
            req = req.header("Idempotency-Key", key);
        }
        return mockMvc.perform(req).andReturn();
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
    void 归属医生结束问诊_患者侧同步终态且不能再发消息() throws Exception {
        String cid = createConsultation(DOCTOR_ID);
        accept(cid);
        Assertions.assertEquals("ACTIVE", patientDetail(cid).path("status").asText());

        MvcResult res = close(cid, "close-ok-" + UUID.randomUUID());
        Assertions.assertEquals(200, res.getResponse().getStatus());
        Assertions.assertEquals("CLOSED", json(res).path("data").path("status").asText(),
                "结束接口必须回显终态，前端据此锁输入");

        // ② 患者侧终态
        Assertions.assertEquals("CLOSED", patientDetail(cid).path("status").asText(),
                "患者端 status 必须同步为 CLOSED");

        // ③ 双方可见的系统提示
        JsonNode msgs = doctorMessages(cid);
        Assertions.assertEquals(2, countRole(msgs, "system_notice"),
                "应有「已接诊」+「已结束」两条系统提示");
        JsonNode last = msgs.get(msgs.size() - 1);
        Assertions.assertEquals("system_notice", last.path("role").asText());
        Assertions.assertTrue(last.path("content").asText().contains("已结束"),
                "末条系统提示应说明问诊已结束；实际=" + last.path("content").asText());

        // ④ 医生待处理列表不再包含已结束会话
        Assertions.assertFalse(inDoctorList(cid), "已结束会话不应再出现在医生待处理列表");

        // ⑤ 患者再发消息 → 409
        mockMvc.perform(post("/api/v1/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "close-msg-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"医生还在吗？\"}"))
                .andExpect(status().isConflict());
    }

    @Test
    void 非本人不可结束_重复结束409_缺幂等键400() throws Exception {
        // 未归属本人（还在认领池、未接诊）→ 404，不泄露会话存在性，也避免越权收口
        String foreign = createConsultation(null);
        Assertions.assertEquals(404, close(foreign, "close-foreign-" + UUID.randomUUID()).getResponse().getStatus());
        Assertions.assertEquals("ACTIVE", patientDetail(foreign).path("status").asText(),
                "越权结束不得改动会话状态");

        // 归属本人：第一次 200，第二次 409（终态不可重复置位）
        String cid = createConsultation(DOCTOR_ID);
        accept(cid);
        Assertions.assertEquals(200, close(cid, "close-dup-" + UUID.randomUUID()).getResponse().getStatus());
        Assertions.assertEquals(409, close(cid, "close-dup2-" + UUID.randomUUID()).getResponse().getStatus());

        // 缺 Idempotency-Key → 400
        String cid2 = createConsultation(DOCTOR_ID);
        Assertions.assertEquals(400, close(cid2, null).getResponse().getStatus());
        Assertions.assertEquals("ACTIVE", patientDetail(cid2).path("status").asText(),
                "缺幂等键的请求不得改动会话状态");
    }
}
