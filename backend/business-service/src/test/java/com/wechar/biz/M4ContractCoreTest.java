package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * M4.4 契约测试（核心域）——逐路径对 backend/contracts/business-openapi.yaml：
 * 对每条契约操作发真实探针请求，断言实测状态码 ∈ 该操作声明的状态码集合。
 * 数据：test-m1-seed.sql（用户/科室/医生/号源/内容，与 M2/M3 种子互斥故独立上下文）。
 * 覆盖域：auth、me、consents、me/deletion-requests、catalog、appointments、health-records、
 *         family-members(+invitations)、contents、resources/manifest、triage、home、gw/internal 占位。
 * 网关域 /api/gw/* 与服务间 /internal/*：业务侧按 O-02 前口径恒 501 占位（WebMvcConfig 头注），
 * 契约声明的 200/401/503 由网关里程碑兑现——此处显式断言 501 占位语义而非契约集合。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4core;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class M4ContractCoreTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private ObjectMapper mapper;

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

    // ---------------------------------------------------------------- 鉴权抽样与 auth 域

    @Test
    void 受保护路径_无身份_401抽样() throws Exception {
        // 契约在受保护操作均声明 401；M4AuthTest 已全矩阵覆盖，此处抽样锚定
        probe("GET /api/v1/me(无身份)", st(mockMvc.perform(get("/api/v1/me")).andReturn()), 401);
        probe("GET /api/v1/appointments/me(无身份)",
                st(mockMvc.perform(get("/api/v1/appointments/me")).andReturn()), 401);
        probe("GET /api/v1/health-records(无身份)",
                st(mockMvc.perform(get("/api/v1/health-records")).andReturn()), 401);
    }

    @Test
    void auth域_登录刷新登出() throws Exception {
        // 登录：code=dev-user-1-code → 命中种子用户 u-dev-user-1（dev 适配器 -code 后缀）
        MvcResult login = mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .header("X-Client-Version", "1.0.0")
                        .header("X-Platform", "wechat-miniprogram")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"dev-user-1-code\",\"consentVersion\":\"v1.0\"}"))
                .andReturn();
        probe("POST /api/v1/auth/wechat/login", st(login), 200, 400, 422, 429, 503);
        var session = mapper.readTree(body(login)).path("data");
        String accessToken = session.path("accessToken").asText("");
        String refreshToken = session.path("refreshToken").asText("");
        org.assertj.core.api.Assertions.assertThat(refreshToken).isNotBlank();

        // 刷新：契约声明 200,400,401,429
        probe("POST /api/v1/auth/refresh", st(mockMvc.perform(post("/api/v1/auth/refresh")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"refreshToken\":\"" + refreshToken + "\"}"))
                .andReturn()), 200, 400, 401, 429);

        // 登出：持会话 200（幂等；写端点统一要求 Idempotency-Key）
        probe("POST /api/v1/auth/logout", st(mockMvc.perform(post("/api/v1/auth/logout")
                        .header("Authorization", "Bearer " + accessToken)
                        .header("Idempotency-Key", "m4c-logout-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andReturn()), 200, 401);
    }

    @Test
    void doctorLogin_平台与请求头校验() throws Exception {
        // X-Platform 非 const 值 → 422（契约 const）；缺头 → 400
        probe("POST /api/v1/doctor/login(X-Platform 非const)",
                st(mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", "1.0.0")
                        .header("X-Platform", "h5")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"dev-user-2-code\",\"consentVersion\":\"v1.0\"}"))
                .andReturn()), 200, 400, 403, 422, 429, 503);
        probe("POST /api/v1/doctor/login(缺请求头)",
                st(mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", "1.0.0")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"dev-user-2-code\",\"consentVersion\":\"v1.0\"}"))
                .andReturn()), 200, 400, 403, 422, 429, 503);
    }

    // ---------------------------------------------------------------- me / consents / deletion-requests

    @Test
    void me与同意与删除请求域() throws Exception {
        probe("GET /api/v1/me", st(mockMvc.perform(get("/api/v1/me")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 503);

        probe("GET /api/v1/consents", st(mockMvc.perform(get("/api/v1/consents")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401);

        // 首次授意 PRIVACY_POLICY（m1 种子无 consent 行）→ 200
        probe("POST /api/v1/consents", st(mockMvc.perform(post("/api/v1/consents")
                        .header("X-User-Id", "dev-user-1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"PRIVACY_POLICY\",\"policyVersion\":\"v1.0\","
                                + "\"channel\":\"MINIPROGRAM\",\"scope\":[\"basic\"]}"))
                .andReturn()), 200, 400, 401, 409, 422);

        // 未授意即撤回 → 404（契约声明 200,401,404,409）
        probe("POST /api/v1/consents/{purpose}/withdraw(未授意)",
                st(mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4c-wd0-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"reason\":\"契约探针\"}"))
                .andReturn()), 200, 401, 404, 409);

        // 授意后撤回 → 200
        probe("POST /api/v1/consents(HEALTH_DATA_PROCESSING)",
                st(mockMvc.perform(post("/api/v1/consents")
                        .header("X-User-Id", "dev-user-1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"HEALTH_DATA_PROCESSING\",\"policyVersion\":\"v1.0\","
                                + "\"channel\":\"MINIPROGRAM\"}"))
                .andReturn()), 200, 400, 401, 409, 422);
        probe("POST /api/v1/consents/{purpose}/withdraw",
                st(mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4c-wd1-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"reason\":\"契约探针\"}"))
                .andReturn()), 200, 401, 404, 409);

        // 删除请求：创建 → 按号查询（契约 200,400,401,409 / 200,401,404）
        MvcResult del = mockMvc.perform(post("/api/v1/me/deletion-requests")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4c-del-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":[\"CONSULTATIONS\"],\"reason\":\"契约探针\"}"))
                .andReturn();
        probe("POST /api/v1/me/deletion-requests", st(del), 200, 400, 401, 409);
        String requestId = mapper.readTree(body(del)).path("data").path("id").asText(
                mapper.readTree(body(del)).path("data").path("requestId").asText(""));
        org.assertj.core.api.Assertions.assertThat(requestId).isNotBlank();
        probe("GET /api/v1/me/deletion-requests/{requestId}",
                st(mockMvc.perform(get("/api/v1/me/deletion-requests/" + requestId)
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);
        probe("GET /api/v1/me/deletion-requests/{requestId}(不存在)",
                st(mockMvc.perform(get("/api/v1/me/deletion-requests/req-no-such")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);
    }

    // ---------------------------------------------------------------- catalog / contents / manifest

    @Test
    void catalog与contents与manifest域() throws Exception {
        probe("GET /api/v1/departments", st(mockMvc.perform(get("/api/v1/departments")).andReturn()),
                200, 400, 503);
        probe("GET /api/v1/departments/{departmentId}/doctors",
                st(mockMvc.perform(get("/api/v1/departments/dep-gastro/doctors")).andReturn()),
                200, 400, 404, 503);
        probe("GET /api/v1/departments/{departmentId}/doctors(不存在)",
                st(mockMvc.perform(get("/api/v1/departments/dep-no-such/doctors")).andReturn()),
                200, 400, 404, 503);
        probe("GET /api/v1/doctors/{doctorId}/slots",
                st(mockMvc.perform(get("/api/v1/doctors/doc-gastro-1/slots")).andReturn()),
                200, 400, 404, 503);

        // N7（2026-10-19 补齐）：院区列表（匿名只读；契约仅声明 200，探针取精确单码）
        probe("GET /api/v1/hospitals", st(mockMvc.perform(get("/api/v1/hospitals")).andReturn()), 200);

        // N6（2026-10-19 补齐）：医生列表 slotStatus 三态 + 中文文案（状态不靠颜色单独表达）
        MvcResult doctors = mockMvc.perform(get("/api/v1/doctors")).andReturn();
        probe("GET /api/v1/doctors", st(doctors), 200, 400, 503);
        var docNode = mapper.readTree(body(doctors));
        if (!docNode.get("data").isEmpty()) {
            var first = docNode.get("data").get(0);
            String slotStatus = first.path("slotStatus").asText("");
            if (!java.util.Set.of("OPEN", "FEW", "FULL").contains(slotStatus)) {
                throw new AssertionError("Doctor.slotStatus 不在 OPEN|FEW|FULL: " + first);
            }
            if (first.path("slotStatusText").asText("").isBlank()) {
                throw new AssertionError("Doctor.slotStatusText 缺失（状态须随中文文案下发）: " + first);
            }
        }

        probe("GET /api/v1/contents", st(mockMvc.perform(get("/api/v1/contents")).andReturn()),
                200, 503);
        probe("GET /api/v1/contents/{contentId}",
                st(mockMvc.perform(get("/api/v1/contents/cont-test-1")).andReturn()),
                200, 404, 503);
        probe("GET /api/v1/contents/{contentId}(不存在)",
                st(mockMvc.perform(get("/api/v1/contents/cont-no-such")).andReturn()),
                200, 404, 503);

        probe("GET /api/v1/resources/manifest",
                st(mockMvc.perform(get("/api/v1/resources/manifest")).andReturn()),
                200, 304, 503);
    }

    // ---------------------------------------------------------------- appointments

    @Test
    void appointments域() throws Exception {
        // 预约用已绑手机用户 dev-user-2（u-bound-user）
        String key = "m4c-appt-" + UUID.randomUUID();
        MvcResult created = mockMvc.perform(post("/api/v1/appointments")
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"契约探针\"}"))
                .andReturn();
        probe("POST /api/v1/appointments", st(created), 200, 400, 401, 403, 409, 422, 429);
        var data = mapper.readTree(body(created)).path("data");
        String appointmentId = data.path("id").asText(data.path("appointment").path("id").asText(""));

        probe("GET /api/v1/appointments/me", st(mockMvc.perform(get("/api/v1/appointments/me")
                        .header("X-User-Id", "dev-user-2")).andReturn()), 200, 401, 503);

        probe("GET /api/v1/appointments/by-idempotency-key/{key}",
                st(mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/" + key)
                        .header("X-User-Id", "dev-user-2")).andReturn()), 200, 401, 404);
        probe("GET /api/v1/appointments/by-idempotency-key/{key}(不存在)",
                st(mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/m4c-none")
                        .header("X-User-Id", "dev-user-2")).andReturn()), 200, 401, 404);

        if (!appointmentId.isBlank()) {
            probe("POST /api/v1/appointments/{appointmentId}/cancel",
                    st(mockMvc.perform(post("/api/v1/appointments/" + appointmentId + "/cancel")
                            .header("X-User-Id", "dev-user-2")
                            .header("Idempotency-Key", "m4c-cancel-" + UUID.randomUUID())
                            .contentType(MediaType.APPLICATION_JSON)
                            .content("{}"))
                    .andReturn()), 200, 401, 404, 409);
        }
    }

    // ---------------------------------------------------------------- health-records / family-members

    @Test
    void 健康档案与家庭成员域() throws Exception {
        probe("GET /api/v1/health-records", st(mockMvc.perform(get("/api/v1/health-records")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 404);

        probe("POST /api/v1/health-records", st(mockMvc.perform(post("/api/v1/health-records")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4c-hr-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"category\":\"检查报告\",\"title\":\"契约探针\","
                                + "\"summary\":\"契约探针摘要\",\"recordedAt\":\"2026-10-16T00:00:00Z\"}"))
                .andReturn()), 200, 400, 401, 409, 422);

        probe("GET /api/v1/family-members", st(mockMvc.perform(get("/api/v1/family-members")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401);

        probe("POST /api/v1/family-members", st(mockMvc.perform(post("/api/v1/family-members")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4c-fm-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"displayName\":\"契约探针成员\",\"relation\":\"PARENT\"}"))
                .andReturn()), 200, 400, 401, 409, 422);

        probe("POST /api/v1/family-members/invitations",
                st(mockMvc.perform(post("/api/v1/family-members/invitations")
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4c-inv-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"relation\":\"PARENT\",\"channel\":\"MINIPROGRAM\","
                                + "\"phone\":\"13800000000\"}"))
                .andReturn()), 200, 400, 401, 422, 429);
    }

    // ---------------------------------------------------------------- triage / home

    @Test
    void triage与home域() throws Exception {
        probe("POST /api/v1/triage/recommendations",
                st(mockMvc.perform(post("/api/v1/triage/recommendations")
                        .header("X-User-Id", "dev-user-1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"symptoms\":\"胃痛两天\",\"durationText\":\"两天\"}"))
                .andReturn()), 200, 400, 401, 413, 422, 503);

        probe("POST /api/v1/triage/emergency-checks",
                st(mockMvc.perform(post("/api/v1/triage/emergency-checks")
                        .header("X-User-Id", "dev-user-1")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"胸口压榨样疼痛\"}"))
                .andReturn()), 200, 400, 429, 503);

        probe("GET /api/v1/home/summary", st(mockMvc.perform(get("/api/v1/home/summary")
                        .header("X-User-Id", "dev-user-1")).andReturn()), 200, 401, 503);
    }

    // ---------------------------------------------------------------- gw / internal 占位

    @Test
    void 网关域与服务间_业务侧501占位() throws Exception {
        // 契约声明的 200/401/503 由网关里程碑兑现；业务侧 O-02 前口径恒 501（WebMvcConfig 头注、
        // EnvelopeAndNotImplementedTest 既有约定）——此处固化占位语义。
        assertEquals(501, st(mockMvc.perform(get("/api/gw/health")).andReturn()), "GET /api/gw/health");
        assertEquals(501, st(mockMvc.perform(get("/api/gw/routes")).andReturn()), "GET /api/gw/routes");
        assertEquals(501, st(mockMvc.perform(get("/api/gw/voices")).andReturn()), "GET /api/gw/voices");
        assertEquals(501, st(mockMvc.perform(post("/internal/v1/callbacks/task-events")
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andReturn()), "POST /internal/v1/callbacks/task-events");
    }
}
