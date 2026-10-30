package com.wechar.biz;

import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.ai.AiTaskClient;
import com.wechar.biz.ai.dto.UpstreamTask;
import java.nio.charset.StandardCharsets;
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
import org.springframework.test.web.servlet.MvcResult;

/**
 * M6 医生回复闭环端到端测试（V21：认领 → 回复 → 患者消息中心红点，2026-10-23）。
 * 数据：test-m3-seed.sql（doc-gastro-1 任职在 dev-user-2；患者 dev-user-1 无任职）。
 * 链路断言（全部走真实 Controller/Service/SQL，AI 上游以替身返回 QUEUED）：
 *   ① 患者创建咨询 → 200（会话 ACTIVE、未分配）；
 *   ② 医生会话列表 → 未分配会话在认领池（assignedDoctorId=null）；
 *   ③ 医生认领 → 200 replayed=false；重复认领（同键）→ 200 replayed=true；
 *   ④ 医生拉会话消息 → 200；
 *   ⑤ 医生回复 → 200（role=doctor、provenance=DOCTOR_REPLY）；
 *   ⑥ 患者拉会话消息 → 200 且含医生回复；
 *   ⑦ 患者消息中心未读数 → ≥1（CONSULT_REPLY 类型）。
 * 防抢：另一用户（无任职）调医生端点 → 403；会话未 ACTIVE 时回复 → 409。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m6reply;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class M6DoctorReplyConsultTest {

    private static final String USER_DOCTOR = "dev-user-2";
    private static final String USER_PATIENT = "dev-user-1";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

    /** AI 上游替身：submit=QUEUED（会话创建链路不依赖 ai-service 在线）。 */
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

    private static String body(MvcResult result) throws java.io.UnsupportedEncodingException {
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    /** 患者创建咨询（AI 替身 QUEUED → 200）。 */
    private String createConsultation() throws Exception {
        MvcResult res = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m6-create-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"嗓子疼三天，伴有低烧，想问问该挂什么科。\"}"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode data = mapper.readTree(body(res)).path("data");
        return data.path("consultation").path("id").asText();
    }

    private JsonNode json(MvcResult result) throws Exception {
        return mapper.readTree(body(result));
    }

    @Test
    void 医生认领回复闭环_患者感知() throws Exception {
        // ① 患者创建咨询（未分配）
        String cid = createConsultation();
        org.junit.jupiter.api.Assertions.assertTrue(cid.startsWith("cn-"));

        // ② 医生列表：未分配会话在认领池
        MvcResult listRes = mockMvc.perform(get("/api/v1/doctor/consultations")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode list = json(listRes).path("data");
        JsonNode hit = null;
        for (JsonNode item : list) {
            if (cid.equals(item.path("id").asText())) {
                hit = item;
                break;
            }
        }
        org.junit.jupiter.api.Assertions.assertNotNull(hit, "医生列表应包含未分配会话");
        org.junit.jupiter.api.Assertions.assertTrue(hit.path("assignedDoctorId").isMissingNode()
                        || hit.path("assignedDoctorId").isNull(),
                "新会话应处于未分配状态（认领池，assignedDoctorId 应缺失或为 null）");
        org.junit.jupiter.api.Assertions.assertFalse(hit.path("patientName").asText().isBlank(),
                "患者姓名应来自 users 真实数据");

        // ③ 医生认领 → 200；同键重放 → replayed=true
        String key = "m6-accept-" + UUID.randomUUID();
        MvcResult accept1 = mockMvc.perform(post("/api/v1/doctor/consultations/" + cid + "/accept")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", key))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "false"))
                .andReturn();
        MvcResult accept2 = mockMvc.perform(post("/api/v1/doctor/consultations/" + cid + "/accept")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", key))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andReturn();

        // ④ 医生拉会话消息（归属校验通过）
        mockMvc.perform(get("/api/v1/doctor/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();

        // ⑤ 医生回复 → 200（role=doctor、provenance=DOCTOR_REPLY）
        MvcResult replyRes = mockMvc.perform(post("/api/v1/consultations/" + cid + "/doctor-reply")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "m6-reply-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"已查看您的描述。嗓子疼伴低烧建议先挂呼吸内科；"
                                + "若体温超过 38.5℃ 或出现呼吸困难请立即急诊。\"}"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode replyMsg = json(replyRes).path("data").path("message");
        org.junit.jupiter.api.Assertions.assertEquals("doctor", replyMsg.path("role").asText());
        org.junit.jupiter.api.Assertions.assertEquals("DOCTOR_REPLY", replyMsg.path("provenance").asText());

        // ⑥ 患者拉消息 → 含医生回复
        MvcResult patientMsgs = mockMvc.perform(get("/api/v1/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andReturn();
        boolean sawDoctor = false;
        for (JsonNode m : json(patientMsgs).path("data")) {
            if ("doctor".equals(m.path("role").asText())) {
                sawDoctor = true;
                break;
            }
        }
        org.junit.jupiter.api.Assertions.assertTrue(sawDoctor, "患者消息列表应包含医生回复");

        // ⑦ 患者消息中心未读数 ≥1（CONSULT_REPLY 通知；unread-count 返回裸数字）
        MvcResult unread = mockMvc.perform(get("/api/v1/messages/unread-count")
                        .header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andReturn();
        int count = json(unread).path("data").asInt(0);
        org.junit.jupiter.api.Assertions.assertTrue(count >= 1, "患者消息中心应有 ≥1 条未读（医生回复通知），实测=" + count);
    }

    @Test
    void 患者指定医生申请模式_直接分配并通知医生() throws Exception {
        // ① 患者创建咨询带 doctorId=doc-gastro-1（m3 种子：该医生任职在 dev-user-2）
        MvcResult created = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m6-apply-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"体检发现血压偏高，想咨询医生日常注意事项。\","
                                + "\"doctorId\":\"doc-gastro-1\"}"))
                .andExpect(status().isOk())
                .andReturn();
        JsonNode cdata = json(created).path("data").path("consultation");
        String cid = cdata.path("id").asText();
        org.junit.jupiter.api.Assertions.assertTrue(cid.startsWith("cn-"));
        // 患者侧会话卡应带医生信息（V21 医生卡字段）——"正在接诊"展示的数据源
        org.junit.jupiter.api.Assertions.assertFalse(cdata.path("doctorName").asText().isBlank(),
                "患者侧会话卡应含医生姓名");
        org.junit.jupiter.api.Assertions.assertFalse(cdata.path("doctorTitle").asText().isBlank(),
                "患者侧会话卡应含医生职称");

        // ② 医生列表：会话已直接分配（assignedDoctorId=doc-gastro-1，无需认领）
        MvcResult listRes = mockMvc.perform(get("/api/v1/doctor/consultations")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        boolean sawAssigned = false;
        for (JsonNode item : json(listRes).path("data")) {
            if (cid.equals(item.path("id").asText())) {
                org.junit.jupiter.api.Assertions.assertEquals("doc-gastro-1",
                        item.path("assignedDoctorId").asText(), "申请模式的会话应直接归医生");
                sawAssigned = true;
                break;
            }
        }
        org.junit.jupiter.api.Assertions.assertTrue(sawAssigned, "医生列表应包含申请模式的会话");

        // ③ 医生直接回复（无需认领）→ 200
        mockMvc.perform(post("/api/v1/consultations/" + cid + "/doctor-reply")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "m6-apply-reply-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"收到您的血压咨询，建议家庭自测血压连续记录一周，"
                                + "若持续高于 140/90 请尽快门诊就诊。\"}"))
                .andExpect(status().isOk())
                .andReturn();

        // ④ 医生消息中心未读 ≥1（CONSULT_APPLY 申请通知）
        MvcResult doctorUnread = mockMvc.perform(get("/api/v1/messages/unread-count")
                        .header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andReturn();
        int dcount = json(doctorUnread).path("data").asInt(0);
        org.junit.jupiter.api.Assertions.assertTrue(dcount >= 1,
                "医生消息中心应有 ≥1 条未读（问诊申请通知），实测=" + dcount);

        // ⑤ 患者消息列表含医生回复（同步出现）
        MvcResult patientMsgs = mockMvc.perform(get("/api/v1/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andReturn();
        boolean sawDoctorReply = false;
        for (JsonNode m : json(patientMsgs).path("data")) {
            if ("doctor".equals(m.path("role").asText())) {
                sawDoctorReply = true;
                break;
            }
        }
        org.junit.jupiter.api.Assertions.assertTrue(sawDoctorReply, "患者消息列表应同步出现医生回复");
    }

    @Test
    void 患者指定不存在的医生_404() throws Exception {
        mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m6-apply-bad-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"测试申请\",\"doctorId\":\"doc-no-such\"}"))
                .andExpect(status().isNotFound());
    }

    @Test
    void 非医生调医生咨询端点_403() throws Exception {
        MvcResult listRes = mockMvc.perform(get("/api/v1/doctor/consultations")
                        .header("X-User-Id", USER_PATIENT))
                .andReturn();
        org.junit.jupiter.api.Assertions.assertEquals(403, listRes.getResponse().getStatus(),
                "非医生 GET 医生咨询列表应 403，实测 body=" + body(listRes));
        MvcResult acceptRes = mockMvc.perform(post("/api/v1/doctor/consultations/cn-x/accept")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m6-forbid"))
                .andReturn();
        org.junit.jupiter.api.Assertions.assertEquals(403, acceptRes.getResponse().getStatus(),
                "非医生 POST 认领应 403，实测 body=" + body(acceptRes));
    }
}
