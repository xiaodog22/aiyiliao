package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 医生叫号幂等键的资源作用域（P0-2 回归）。
 *
 * 背景：幂等键唯一约束是 (operator_user_id, idempotency_key)，键**不绑定预约**。
 * 修复前 request_digest 只含 toStatus|expectedVersion|note，于是同一个键被复用到另一条预约、
 * 且三个字段恰好相同时，会命中重放分支返回**上一条预约**的数据并 200，
 * 目标预约既不流转也不报错（静默错误，比报错更危险）。
 *
 * 断言三件事：
 *  1. 同键同预约同载荷 → 重放 200，仍返回同一预约（合法重试不受影响）；
 *  2. 同键跨预约同载荷 → 409 IDEMPOTENCY_KEY_REUSE，且响应里不得出现第一条预约；
 *  3. 被拒的目标预约状态保持不变（没有"报错了但其实改了"）。
 *
 * 独立上下文（专属 H2 库 + 同一份 m3 种子），避免与 M4ContractDoctorTest 互相改数据。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4idemdigest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class M4DoctorIdempotencyDigestTest {

    private static final String USER_DOCTOR = "dev-user-2";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    private static String body(String toStatus, int expectedVersion, String note) {
        return "{\"toStatus\":\"" + toStatus + "\",\"expectedVersion\":" + expectedVersion
                + ",\"note\":\"" + note + "\"}";
    }

    @Test
    void 同键跨预约必须409且不得返回上一条预约() throws Exception {
        String key = "idem-cross-" + java.util.UUID.randomUUID();
        String payload = body("CONFIRMED", 1, "叫号");

        // 1) ap-m3-1：PENDING → CONFIRMED 成功
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-1/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("ap-m3-1"))
                .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
                // D1 统一：首次真实流转不得携带重放标记
                .andExpect(header().doesNotExist("Idempotency-Replayed"));

        // 2) 合法重放：同键 + 同预约 + 同载荷 → 200，仍返回 ap-m3-1
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-1/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("ap-m3-1"))
                // D1 统一（2026-10-18）：重放必须回 Idempotency-Replayed: true，
                // 与 care-plan / 预约创建 / 问诊创建的行为一致
                .andExpect(header().string("Idempotency-Replayed", "true"));

        // 3) 同键换一条预约（ap-m3-2，同为 PENDING v1，载荷完全相同）→ 必须 409
        MvcResult cross = mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-2/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(payload))
                .andReturn();
        assertEquals(409, cross.getResponse().getStatus(),
                "同一幂等键用于不同预约必须 409，不能当作重放返回上一条预约");
        String crossBody = cross.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        assertTrue(crossBody.contains("IDEMPOTENCY_KEY_REUSE"), "错误码须为 IDEMPOTENCY_KEY_REUSE：" + crossBody);
        assertFalse(crossBody.contains("\"ap-m3-1\""), "409 响应不得夹带上一条预约的内容：" + crossBody);

        // 4) 目标预约未被改动（没有"先改后报错"）
        String statusAfter = jdbc.queryForObject(
                "SELECT status FROM appointments WHERE id = ?", String.class, "ap-m3-2");
        assertEquals("PENDING", statusAfter, "被拒绝的预约状态不得变化");
    }

    @Test
    void 缺幂等键返回400() throws Exception {
        MvcResult r = mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-3/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("CONFIRMED", 1, "无键")))
                .andReturn();
        assertEquals(400, r.getResponse().getStatus(), "契约声明 Idempotency-Key 必填，缺失应 400");
    }

    @Test
    void 非本医生预约返回404() throws Exception {
        // ap-m3-resp 属 doc-resp-1（他科）→ 404，不泄露存在性
        MvcResult r = mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-resp/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "idem-other-" + java.util.UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body("CONFIRMED", 1, "越权")))
                .andReturn();
        assertEquals(404, r.getResponse().getStatus(), "他科预约应 404，不得 403 泄露存在性");
    }
}
