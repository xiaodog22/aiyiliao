package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 个人信息设置扩展（V8）契约测试 —— 补齐 M1~M9 未覆盖的 7 个操作：
 *  GET/PUT /me/extended · POST /me/identity · POST /me/insurance · PUT /me/account ·
 *  POST /me/avatar · POST /health-records/{id}/interpret。
 *
 * 背景（2026-10-20 评审发现）：上述端点在 MeController/PatientController 已实现，
 * 但既有 35 个测试类无一引用（grep 实证），属零覆盖操作；本类按契约为其补探针。
 * 数据：test-m1-seed.sql（u-dev-user-1 / u-bound-user）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m8meext;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class MeExtendedProfileContractTest {

    private static final String USER = "u-dev-user-1";
    private static final String OTHER = "u-bound-user";
    /** GB 11643 校验位正确的 18 位身份证号（测试专用假号）。 */
    private static final String VALID_ID = "110105194912310003";
    private static final String INTERPRET_DISCLAIMER = "AI 解读结果仅供参考，不能替代医师诊断。";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

    @Autowired
    private JdbcTemplate jdbc;

    /**
     * 上游替身（2026-10-22）：`interpret` 已从规则式模板改为**真实模型编排**
     * （AiTaskService.create(type=INTERPRET) → await），故本类必须桩掉 AiTaskClient，
     * 否则测试会打到不存在的 ai-service 并如实返回 503。
     */
    @org.springframework.test.context.bean.override.mockito.MockitoBean
    private com.wechar.biz.ai.AiTaskClient aiClient;

    @org.junit.jupiter.api.BeforeEach
    void stubAiUpstream() {
        org.mockito.Mockito.reset(aiClient);
        // 提交：受理 QUEUED（policyVersion 必填 —— ai_tasks 列 NOT NULL）
        org.mockito.Mockito.when(aiClient.submit(org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any()))
                .thenAnswer(inv -> new com.wechar.biz.ai.dto.UpstreamTask(
                        "up-" + java.util.UUID.randomUUID(), (String) inv.getArgument(1),
                        "QUEUED", "safety_check", "small-default", null, null, "POLICY-v1",
                        false, null, null, java.time.Instant.now(), null,
                        java.time.Instant.now().plusSeconds(120)));
        // 查询：立刻 SUCCEEDED，返回一份合法的 INTERPRET 结果（summary + sections）
        org.mockito.Mockito.when(aiClient.get(org.mockito.ArgumentMatchers.any()))
                .thenAnswer(inv -> new com.wechar.biz.ai.dto.UpstreamTask(
                        inv.getArgument(0), "INTERPRET", "SUCCEEDED", "postprocess",
                        "small-default", "qwen2.5:0.5b", "v1", "POLICY-v1", false,
                        new com.wechar.biz.ai.dto.UpstreamTask.UpstreamTaskResult(
                                null, null, null, null, null, "AI_GENERATED", false, null,
                                "zh-CN", false, null, null,
                                "该报告标注未见明显异常，以下为报告要点的通俗说明。",
                                interpretSections()),
                        null, java.time.Instant.now(), java.time.Instant.now(), null));
    }

    /** 分节解读桩：标题 + 通俗正文，不含诊断/处方措辞（合规断言用）。 */
    private static com.fasterxml.jackson.databind.JsonNode interpretSections() {
        var array = com.fasterxml.jackson.databind.node.JsonNodeFactory.instance.arrayNode();
        array.addObject().put("title", "指标含义")
                .put("body", "白细胞计数反映身体免疫状态，本次结果处在参考范围内。")
                .put("abnormal", false);
        return array;
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

    /** 建档并置 reportStatus=READY，返回 recordId（interpret 前置）。 */
    private String createReadyRecord(String user, String idemKey) throws Exception {
        MvcResult created = mockMvc.perform(post("/api/v1/health-records")
                        .header("X-User-Id", user)
                        .header("Idempotency-Key", idemKey)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"category\":\"EXAM\",\"title\":\"血常规\",\"summary\":\"白细胞轻度偏高\","
                                + "\"recordedAt\":\"2026-10-01T10:00:00Z\",\"abnormal\":true}"))
                .andExpect(status().isOk())
                .andReturn();
        String recordId = mapper.readTree(body(created)).path("data").path("id").asText();
        jdbc.update("UPDATE health_records SET report_status = 'READY' WHERE id = ?", recordId);
        return recordId;
    }

    // ---------------------------------------------------------------- GET/PUT /me/extended

    @Test
    void me_extended_无身份_401() throws Exception {
        probe("GET /api/v1/me/extended(无身份)", st(mockMvc.perform(get("/api/v1/me/extended")).andReturn()), 401);
    }

    @Test
    void me_extended_读取_200_掩码字段齐全() throws Exception {
        mockMvc.perform(get("/api/v1/me/extended").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.idCardVerified").isBoolean())
                .andExpect(jsonPath("$.data.insuranceBound").isBoolean())
                .andExpect(jsonPath("$.data.version").isNumber());
    }

    @Test
    void me_extended_更新_null保留原值() throws Exception {
        mockMvc.perform(put("/api/v1/me/extended").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"zhang@example.com\",\"residence\":\"北京市海淀区\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.email").value("zhang@example.com"));
        // 空体再PUT：email/residence 应保留（null=保留，不是清空）
        mockMvc.perform(put("/api/v1/me/extended").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.email").value("zhang@example.com"))
                .andExpect(jsonPath("$.data.residence").value("北京市海淀区"));
    }

    @Test
    void me_extended_未知字段_400() throws Exception {
        // 契约 ExtendedProfileUpdate additionalProperties:false + 全局严格反序列化：
        // 未知字段必须 400（不得静默接受）——2026-10-20 评审点名的探针。
        probe("PUT /api/v1/me/extended(未知字段)",
                st(mockMvc.perform(put("/api/v1/me/extended").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"a@b.com\",\"bogusField\":\"x\"}")).andReturn()), 400);
    }

    @Test
    void me_extended_邮箱格式非法_422() throws Exception {
        probe("PUT /api/v1/me/extended(邮箱格式)",
                st(mockMvc.perform(put("/api/v1/me/extended").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"email\":\"not-an-email\"}")).andReturn()), 422);
    }

    // ---------------------------------------------------------------- POST /me/identity

    @Test
    void me_identity_合法_200_脱敏落库() throws Exception {
        MvcResult r = mockMvc.perform(post("/api/v1/me/identity").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"张三\",\"idCardNumber\":\"" + VALID_ID + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.idCardVerified").value(true))
                .andExpect(jsonPath("$.data.idCardMasked").value("1101**********0003"))
                .andReturn();
        // 响应体不得出现身份证明文
        if (body(r).contains(VALID_ID)) {
            throw new AssertionError("身份证明文泄露到响应体");
        }
    }

    @Test
    void me_identity_校验位错误_422() throws Exception {
        MvcResult r = mockMvc.perform(post("/api/v1/me/identity").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"name\":\"张三\",\"idCardNumber\":\"110105194912310004\"}"))
                .andReturn();
        probe("POST /api/v1/me/identity(校验位错)", st(r), 422);
        if (!body(r).contains("INVALID_ID_CARD")) {
            throw new AssertionError("期望错误码 INVALID_ID_CARD");
        }
    }

    // ---------------------------------------------------------------- POST /me/insurance

    @Test
    void me_insurance_绑定_200_脱敏() throws Exception {
        mockMvc.perform(post("/api/v1/me/insurance").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"insuranceType\":\"职工基本医疗保险\",\"insuranceNo\":\"YB12345678\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.insuranceBound").value(true))
                .andExpect(jsonPath("$.data.insuranceMasked").value("****5678"));
    }

    @Test
    void me_insurance_类型非法_422() throws Exception {
        probe("POST /api/v1/me/insurance(类型非法)",
                st(mockMvc.perform(post("/api/v1/me/insurance").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"insuranceType\":\"商业保险\",\"insuranceNo\":\"YB12345678\"}")).andReturn()), 422);
    }

    // ---------------------------------------------------------------- PUT /me/account

    @Test
    void me_account_改名_200_同步契约me() throws Exception {
        String newName = "测试改名" + UUID.randomUUID().toString().substring(0, 6);
        mockMvc.perform(put("/api/v1/me/account").header("X-User-Id", USER)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"" + newName + "\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.displayName").value(newName));
        mockMvc.perform(get("/api/v1/me").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.displayName").value(newName));
    }

    // ---------------------------------------------------------------- POST /me/avatar

    @Test
    void me_avatar_png_200() throws Exception {
        byte[] bytes = new byte[2048];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) (i % 251);
        }
        mockMvc.perform(multipart("/api/v1/me/avatar")
                        .file(new MockMultipartFile("file", "avatar.png", "image/png", bytes))
                        .header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.avatarUrl").value(
                        org.hamcrest.Matchers.startsWith("/api/v1/avatars/")));
    }

    @Test
    void me_avatar_超2MB_413() throws Exception {
        byte[] bytes = new byte[2 * 1024 * 1024 + 1];
        probe("POST /api/v1/me/avatar(超2MB)",
                st(mockMvc.perform(multipart("/api/v1/me/avatar")
                        .file(new MockMultipartFile("file", "big.png", "image/png", bytes))
                        .header("X-User-Id", USER)).andReturn()), 413);
    }

    @Test
    void me_avatar_非图片_415() throws Exception {
        byte[] bytes = "GIF89a-not-really".getBytes(StandardCharsets.UTF_8);
        probe("POST /api/v1/me/avatar(非图片)",
                st(mockMvc.perform(multipart("/api/v1/me/avatar")
                        .file(new MockMultipartFile("file", "a.gif", "image/gif", bytes))
                        .header("X-User-Id", USER)).andReturn()), 415);
    }

    // ---------------------------------------------------------------- POST /health-records/{id}/interpret

    @Test
    void interpret_READY_200_disclaimer原样() throws Exception {
        String recordId = createReadyRecord(USER, "mei-interp-ready-01");
        MvcResult r = mockMvc.perform(post("/api/v1/health-records/" + recordId + "/interpret")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "mei-interp-ready-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"SUMMARY\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("READY"))
                .andExpect(jsonPath("$.data.disclaimer").value(INTERPRET_DISCLAIMER))
                .andReturn();
        // 合规红线：不得给出诊断结论/用药剂量
        String body = body(r);
        for (String banned : new String[]{"确诊", "处方", "用药剂量", "诊断结论"}) {
            if (body.contains(banned)) {
                throw new AssertionError("解读内容含违禁表述: " + banned);
            }
        }
    }

    @Test
    void interpret_DETAIL_200() throws Exception {
        String recordId = createReadyRecord(USER, "mei-interp-detail-01");
        probe("POST /health-records/{id}/interpret(DETAIL)",
                st(mockMvc.perform(post("/api/v1/health-records/" + recordId + "/interpret")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "mei-interp-detail-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"DETAIL\"}")).andReturn()), 200);
    }

    @Test
    void interpret_报告未出具_422() throws Exception {
        // 建档后不置 READY（reportStatus 为 null）→ 422 REPORT_NOT_READY
        MvcResult created = mockMvc.perform(post("/api/v1/health-records")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "mei-interp-pending-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"category\":\"EXAM\",\"title\":\"尿常规\",\"recordedAt\":\"2026-10-02T10:00:00Z\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String recordId = mapper.readTree(body(created)).path("data").path("id").asText();
        MvcResult r = mockMvc.perform(post("/api/v1/health-records/" + recordId + "/interpret")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "mei-interp-ready-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"SUMMARY\"}"))
                .andReturn();
        probe("POST /health-records/{id}/interpret(未出具)", st(r), 422);
        if (!body(r).contains("REPORT_NOT_READY")) {
            throw new AssertionError("期望错误码 REPORT_NOT_READY");
        }
    }

    @Test
    void interpret_scope非法_422_不静默降级() throws Exception {
        String recordId = createReadyRecord(USER, "mei-interp-scope-01");
        probe("POST /health-records/{id}/interpret(scope非法)",
                st(mockMvc.perform(post("/api/v1/health-records/" + recordId + "/interpret")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "mei-interp-scope-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"BOGUS\"}")).andReturn()), 422);
    }

    @Test
    void interpret_撤回同意_422() throws Exception {
        // 用独立用户隔离同意状态（同库其他用例的授权不影响本用例）
        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", OTHER)
                        .header("Idempotency-Key", "mei-consent-grant-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"HEALTH_DATA_PROCESSING\",\"policyVersion\":\"v1.0\","
                                + "\"channel\":\"MINIPROGRAM\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .header("X-User-Id", OTHER)
                        .header("Idempotency-Key", "mei-consent-withdraw-01"))
                .andExpect(status().isOk());
        String recordId = createReadyRecord(OTHER, "mei-interp-withdrawn-01");
        MvcResult r = mockMvc.perform(post("/api/v1/health-records/" + recordId + "/interpret")
                        .header("X-User-Id", OTHER)
                        .header("Idempotency-Key", "mei-interp-withdrawn-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"SUMMARY\"}"))
                .andReturn();
        probe("POST /health-records/{id}/interpret(撤回同意)", st(r), 422);
        if (!body(r).contains("CONSENT_WITHDRAWN")) {
            throw new AssertionError("期望错误码 CONSENT_WITHDRAWN");
        }
    }

    @Test
    void interpret_越权_404不泄露存在性() throws Exception {
        String recordId = createReadyRecord(USER, "mei-interp-idor-01");
        probe("POST /health-records/{id}/interpret(他人档案)",
                st(mockMvc.perform(post("/api/v1/health-records/" + recordId + "/interpret")
                        .header("X-User-Id", OTHER)
                        .header("Idempotency-Key", "mei-interp-withdrawn-01")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"SUMMARY\"}")).andReturn()), 404);
    }
}
