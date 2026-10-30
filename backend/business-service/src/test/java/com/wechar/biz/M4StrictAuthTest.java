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
 * M4 strict 鉴权档测试（生产默认 app.auth.mode=strict）。
 *
 * strict 的核心承诺：**X-User-Id 被完全忽略**，身份只来自会话 Bearer。
 * 这条覆盖了客户端自报身份这一典型越权向量——契约请求不带 X-User-Id，
 * 任何附带该头的请求不得改变服务端判定的主体。
 *
 * 与 {@link M4AuthTest}（header 开发档）互为补充：header 档为真机 E2E 保留
 * X-User-Id 开发身份源，但同样拒绝"无任何身份"。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4stricttest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.auth.mode=strict"
})
@AutoConfigureMockMvc
class M4StrictAuthTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    @Test
    void strict档_XUserId不是身份源_无令牌一律401() throws Exception {
        mockMvc.perform(get("/api/v1/me").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("UNAUTHORIZED"));
        mockMvc.perform(get("/api/v1/appointments/me").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isUnauthorized());
        // 匿名路径不因缺令牌失败（与 header 档一致）
        mockMvc.perform(get("/api/v1/departments"))
                .andExpect(status().isOk());
    }

    @Test
    void strict档_会话Bearer可用_且会话主体不受XUserId干扰() throws Exception {
        String body = mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "dev")
                        .header("X-Platform", "wechat-miniprogram")
                        .content("{\"code\":\"dev-code-strict-1\",\"consentVersion\":\"v1\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String access = java.util.regex.Pattern.compile("\"(at-[^\"]+)\"").matcher(body)
                .results().reduce((a, b) -> b).map(m -> m.group(1)).orElse("");

        // 只带 X-User-Id 不带令牌 → 401（strict 下该头被忽略）
        mockMvc.perform(get("/api/v1/me").header("X-User-Id", "dev-user-2"))
                .andExpect(status().isUnauthorized());
        // 带真实令牌 → 200，主体是会话归属人
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + access))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("u-dev-user-1"));
        // 令牌 + 伪造 X-User-Id 并存：主体仍由会话决定（不被头覆盖）
        mockMvc.perform(get("/api/v1/me")
                        .header("Authorization", "Bearer " + access)
                        .header("X-User-Id", "dev-user-2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("u-dev-user-1"));
        // 写操作同样：身份取自会话（写入本人名下数据）
        mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("Authorization", "Bearer " + access)
                        .header("Idempotency-Key", "m4-strict-hr-0001")
                        .header("X-User-Id", "dev-user-2")
                        .content("{\"category\":\"VITALS\",\"title\":\"晨起血压\",\"recordedAt\":\"2026-01-01T08:00:00Z\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value(org.hamcrest.Matchers.startsWith("hr-")));
    }

    @Test
    void strict档_伪造令牌_401_SESSION_REVOKED且不建用户() throws Exception {
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer at-ffffffff-fake"))
                .andExpect(status().isUnauthorized())
                .andExpect(jsonPath("$.code").value("SESSION_REVOKED"));
        // 非 at- 前缀的"历史联调"令牌在 strict 下同样不被采信
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer some-opaque-token"))
                .andExpect(status().isUnauthorized());
        // 伪造令牌不得导致任何用户被创建（鉴权失败只回 401，不走 ensureUser 建用户）
        Integer users = jdbc.queryForObject("SELECT COUNT(*) FROM users", Integer.class);
        org.assertj.core.api.Assertions.assertThat(users).isEqualTo(3); // 仅 test-m1-seed 的 3 个用户
    }

    @Test
    void strict档_未实现路径仍返回501_不被鉴权抢先401() throws Exception {
        // /api/gw/* 不在拦截范围：业务后端本无 handler → 501 语义保持
        mockMvc.perform(get("/api/gw/health"))
                .andExpect(status().isNotImplemented())
                .andExpect(jsonPath("$.code").value("NOT_IMPLEMENTED"));
    }
}
