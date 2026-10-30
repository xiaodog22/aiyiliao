package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * M4.4 契约测试（医生/床位域）——逐路径对 backend/contracts/business-openapi.yaml：
 * 断言实测状态码 ∈ 该操作声明的状态码集合。
 * 数据：test-m3-seed.sql（doc-gastro-1 → u-dev-user-2 任职、ap-m3-* 挂号、床位/病区，
 * 与 M1/M2 种子互斥故独立上下文）。医生端认证沿用 itest header 档（X-User-Id=openid）。
 * 覆盖域：doctor/login（任职 200/403、平台 const 422）、doctor/workbench、doctor/appointments、
 *         doctor/appointments/{id}/status（乐观锁流转）、beds 列表、beds/{id}/assignment。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4doctor;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class M4ContractDoctorTest {

    /** 已登记医生任职（doc-gastro-1）。 */
    private static final String USER_DOCTOR = "dev-user-2";
    /** 无医生任职（医生端应 403）。 */
    private static final String USER_PATIENT = "dev-user-1";
    private static final String PLATFORM = "wechat-miniprogram";
    private static final String CLIENT_VERSION = "1.0.0";

    @Autowired
    private MockMvc mockMvc;

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

    private static String loginBody(String code) {
        return "{\"code\":\"" + code + "\",\"consentVersion\":\"v1.0\"}";
    }

    // ---------------------------------------------------------------- doctor/login

    @Test
    void doctorLogin域() throws Exception {
        // 任职命中 → 200（M3 同款探针口径）
        probe("POST /api/v1/doctor/login",
                st(mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .header("X-Platform", PLATFORM)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("dev-user-2-code")))
                .andReturn()), 200, 400, 403, 422, 429, 503);

        // 非任职账号 → 403（契约声明 403）
        probe("POST /api/v1/doctor/login(非任职)",
                st(mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .header("X-Platform", PLATFORM)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("dev-user-1-code")))
                .andReturn()), 200, 400, 403, 422, 429, 503);
    }

    // ---------------------------------------------------------------- workbench / doctor appointments

    @Test
    void workbench与doctorAppointments域() throws Exception {
        probe("GET /api/v1/doctor/workbench",
                st(mockMvc.perform(get("/api/v1/doctor/workbench")
                        .header("X-User-Id", USER_DOCTOR)).andReturn()), 200, 401, 403, 503);
        probe("GET /api/v1/doctor/workbench(非医生)",
                st(mockMvc.perform(get("/api/v1/doctor/workbench")
                        .header("X-User-Id", USER_PATIENT)).andReturn()), 200, 401, 403, 503);

        probe("GET /api/v1/doctor/appointments",
                st(mockMvc.perform(get("/api/v1/doctor/appointments")
                        .header("X-User-Id", USER_DOCTOR)).andReturn()), 200, 401, 403);
        probe("GET /api/v1/doctor/appointments(非医生)",
                st(mockMvc.perform(get("/api/v1/doctor/appointments")
                        .header("X-User-Id", USER_PATIENT)).andReturn()), 200, 401, 403);

        // N3（2026-10-19 补齐）：医生待处理事项（只返回服务端可判定的待办；非医生 → 403）
        probe("GET /api/v1/doctor/todos",
                st(mockMvc.perform(get("/api/v1/doctor/todos")
                        .header("X-User-Id", USER_DOCTOR)).andReturn()), 200, 401, 403, 503);
        probe("GET /api/v1/doctor/todos(非医生)",
                st(mockMvc.perform(get("/api/v1/doctor/todos")
                        .header("X-User-Id", USER_PATIENT)).andReturn()), 200, 401, 403, 503);

        // N18（2026-10-19 补齐）：统计概览（200 结构含 5 字段、inProgress 恒 null；非医生 → 403）
        MvcResult overview = mockMvc.perform(get("/api/v1/doctor/overview")
                .header("X-User-Id", USER_DOCTOR)).andReturn();
        probe("GET /api/v1/doctor/overview", st(overview), 200, 401, 403);
        var node = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(overview.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8));
        for (String field : new String[] {"waiting", "inProgress", "done", "todayTotal", "pendingTodos"}) {
            if (!node.get("data").has(field)) {
                throw new AssertionError("DoctorOverview 缺字段 " + field + ": " + node);
            }
        }
        if (!node.get("data").get("inProgress").isNull()) {
            throw new AssertionError("inProgress 应恒为 null（状态机无接诊中状态，不可判定）: " + node);
        }
        probe("GET /api/v1/doctor/overview(非医生)",
                st(mockMvc.perform(get("/api/v1/doctor/overview")
                        .header("X-User-Id", USER_PATIENT)).andReturn()), 200, 401, 403);
    }

    // ---------------------------------------------------------------- status 流转 / beds

    @Test
    void doctorStatus与beds域() throws Exception {
        // 状态流转（乐观锁）：PENDING → CONFIRMED，expectedVersion=1 → 200
        probe("POST /api/v1/doctor/appointments/{appointmentId}/status",
                st(mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-1/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "m4cd-status-" + java.util.UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":1,"
                                + "\"note\":\"契约探针\"}"))
                .andReturn()), 200, 401, 403, 404, 409, 422);

        // 他科挂号 → 404（范围隔离不泄露存在性；契约声明 404）
        probe("POST /api/v1/doctor/appointments/{appointmentId}/status(他科)",
                st(mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-resp/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "m4cd-status2-" + java.util.UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":1}"))
                .andReturn()), 200, 401, 403, 404, 409, 422);

        probe("GET /api/v1/beds", st(mockMvc.perform(get("/api/v1/beds")
                        .header("X-User-Id", USER_DOCTOR)).andReturn()), 200, 401, 403);
        probe("GET /api/v1/beds(非医生)",
                st(mockMvc.perform(get("/api/v1/beds")
                        .header("X-User-Id", USER_PATIENT)).andReturn()), 200, 401, 403);

        // 床位分配（乐观锁）：AVAILABLE v1 + ASSIGN → 200
        probe("POST /api/v1/beds/{bedId}/assignment",
                st(mockMvc.perform(post("/api/v1/beds/bed-gastro-a-01/assignment")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "m4cd-bed-" + java.util.UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"ASSIGN\",\"patientRef\":\"u-m3-patient\","
                                + "\"expectedVersion\":1,\"note\":\"契约探针\"}"))
                .andReturn()), 200, 401, 403, 404, 409, 422);
    }
}
