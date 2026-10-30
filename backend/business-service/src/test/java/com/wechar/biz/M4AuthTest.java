package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * M4 鉴权收口测试（08B §M4「鉴权/授权」+ 验收清单 U-02/TC-B11）。
 *
 * 覆盖（header 档 = dev/itest 语义）：
 *  1. 契约声明 401 的受保护路径：无任何身份 → 401 UNAUTHORIZED（U-02 缺陷修复：
 *     M1 时期匿名即 dev-user-1 返回 200）；
 *  2. 契约 security:[] / 未声明 401 的匿名路径：无身份仍可用；
 *  3. 携带已撤销 / 伪造的 at- 前缀令牌 → 401 SESSION_REVOKED（不回退为 openid、不建用户）；
 *  4. logout 重复撤销幂等 200（唯一放行已撤销令牌的路径）；
 *  5. 登录签发的真实会话 Bearer 全链可用。
 *
 * strict 档（生产）单独由 {@link M4StrictAuthTest} 覆盖：X-User-Id 被忽略。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4authtest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class M4AuthTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    /** 契约声明 401 的代表性受保护路径（按域抽样，全部非 security:[]）。 */
    private static final String[][] PROTECTED = {
            {"/api/v1/me", "GET"},
            {"/api/v1/appointments/me", "GET"},
            {"/api/v1/consultations", "GET"},
            {"/api/v1/health-records", "GET"},
            {"/api/v1/family-members", "GET"},
            {"/api/v1/consents", "GET"},
            {"/api/v1/home/summary", "GET"},
            {"/api/v1/voice/models", "GET"},
            {"/api/v1/doctor/workbench", "GET"},
            {"/api/v1/beds", "GET"},
            {"/api/v1/triage/recommendations", "POST"},
            {"/api/v1/me/deletion-requests/req-nonexistent", "GET"},
    };

    @Test
    void 受保护路径_无任何身份_一律401_UNAUTHORIZED() throws Exception {
        StringBuilder failures = new StringBuilder();
        for (String[] p : PROTECTED) {
            var req = "POST".equals(p[1])
                    ? org.springframework.test.web.servlet.request.MockMvcRequestBuilders
                            .post(p[0]).contentType(MediaType.APPLICATION_JSON)
                            .content("{\"symptoms\":\"腹痛\"}")
                    : org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get(p[0]);
            var result = mockMvc.perform(req).andReturn();
            int status = result.getResponse().getStatus();
            String body = result.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
            if (status != 401 || !body.contains("\"code\":\"UNAUTHORIZED\"")) {
                failures.append("\n  ").append(p[1]).append(' ').append(p[0])
                        .append(" → ").append(status).append(' ').append(body);
            }
        }
        org.assertj.core.api.Assertions.assertThat(failures.toString())
                .as("以下受保护路径未按契约返回 401 UNAUTHORIZED")
                .isEmpty();
    }

    @Test
    void 匿名路径_无身份_仍可用_不被拦截器误伤() throws Exception {
        mockMvc.perform(get("/api/v1/departments"))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/resources/manifest")
                        .param("platform", "wechat-miniprogram"))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/triage/emergency-checks")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"突然昏迷不醒\"}"))
                .andExpect(status().isOk());
        mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "dev")
                        .header("X-Platform", "wechat-miniprogram")
                        .content("{\"code\":\"dev-code-alpha\",\"consentVersion\":\"v1\"}"))
                .andExpect(status().isOk());
    }

    @Test
    void 伪造的at前缀令牌_受保护路径_401_SESSION_REVOKED() throws Exception {
        mockMvc.perform(get("/api/v1/appointments/me")
                        .header("Authorization", "Bearer at-00000000-fake-token"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        // 匿名路径忽略陈旧令牌（登录/刷新不被陈旧令牌阻断）
        mockMvc.perform(get("/api/v1/departments")
                        .header("Authorization", "Bearer at-00000000-fake-token"))
                .andExpect(status().isOk());
    }

    @Test
    void 已撤销会话的access令牌_受保护路径_401_SESSION_REVOKED() throws Exception {
        String access = login("dev-code-logout-1");
        // 先验证可用
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + access))
                .andExpect(status().isOk());
        // 撤销整链
        mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + access)
                        .header("Idempotency-Key", "m4-logout-key-0001")
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.revoked").value(true));
        // 撤销后 → 401
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + access))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        // 重复注销幂等 200（唯一放行已撤销令牌的路径）
        mockMvc.perform(post("/api/v1/auth/logout")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + access)
                        .header("Idempotency-Key", "m4-logout-key-0002")
                        .content("{}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.revoked").value(true));
    }

    @Test
    void 会话Bearer_全链可用_且身份来自会话而非头() throws Exception {
        String access = login("dev-code-good-1");
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + access))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("u-dev-user-1"));
        // 会话指向谁就是谁：不接受客户端用 X-User-Id 覆盖会话身份（strict 由另一类覆盖，
        // 此处 header 档 X-User-Id 在无 Bearer 时才是身份源）
        mockMvc.perform(get("/api/v1/appointments/me")
                        .header("Authorization", "Bearer " + access)
                        .header("X-User-Id", "dev-user-2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isArray());
    }

    @Test
    void IDOR抽查_他人对象一律404_不泄漏存在性() throws Exception {
        // dev-user-1 名下的预约（种子/前置创建），dev-user-2 访问 → 404
        String key = "m4-idor-key-0001";
        String created = mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", key)
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"张三\"}"))
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String id = extract(created, "ap-");
        org.assertj.core.api.Assertions.assertThat(id).isNotBlank();

        // 本人可读
        mockMvc.perform(get("/api/v1/appointments/me").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk());
        // 按幂等键查他人对象 → 404（不区分不存在与不属于你）
        mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/" + key)
                        .header("X-User-Id", "dev-user-2"))
                .andExpect(status().isNotFound());
        // 取消他人预约 → 404
        mockMvc.perform(post("/api/v1/appointments/" + id + "/cancel")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "m4-idor-cancel-0001")
                        .content("{}"))
                .andExpect(status().isNotFound());
        // 医生端越权：dev-user-1/2/3 在 M1 种子中均无医生任职 → 403（不泄漏工作台范围）
        mockMvc.perform(get("/api/v1/doctor/workbench").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }

    private String login(String code) throws Exception {
        String body = mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "dev")
                        .header("X-Platform", "wechat-miniprogram")
                        .content("{\"code\":\"" + code + "\",\"consentVersion\":\"v1\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        return extract(body, "at-");
    }

    private static String extract(String body, String prefix) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"(" + java.util.regex.Pattern.quote(prefix) + "[^\"]+)\"").matcher(body);
        String found = null;
        while (m.find()) {
            found = m.group(1);
        }
        return found == null ? "" : found;
    }
}
