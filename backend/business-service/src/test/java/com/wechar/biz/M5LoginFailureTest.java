package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.auth.MockWechatServer;
import com.wechar.biz.common.AuthSessionStore;
import com.wechar.biz.user.UserRepository;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Optional;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 微信身份校验<b>成功之后</b>的失败面：用户映射失败、后端会话签发失败。
 *
 * <p>要求：两种情况都不得产出可用的伪造会话——响应里没有 accessToken，
 * auth_sessions 不新增行，错误按统一信封返回（500 INTERNAL_ERROR，细节只在服务端日志）。</p>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=prodtest",
        "app.rate-limit.enabled=false",
        "app.audit.enabled=false"
})
@AutoConfigureMockMvc
class M5LoginFailureTest {

    private static final String H2_URL =
            "jdbc:h2:mem:m5loginfailure;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                    + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1";

    private static final MockWechatServer MOCK = startMock();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @MockitoBean
    private UserRepository userRepository;

    @MockitoBean
    private AuthSessionStore authSessionStore;

    private static MockWechatServer startMock() {
        try {
            return new MockWechatServer();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> H2_URL);
        registry.add("spring.datasource.username", () -> "sa");
        registry.add("spring.datasource.password", () -> "");
        registry.add("phone.key-base64", () -> "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
        registry.add("spring.sql.init.mode", () -> "always");
        registry.add("spring.sql.init.encoding", () -> "UTF-8");
        registry.add("spring.sql.init.data-locations", () -> "classpath:db/test-m5-seed.sql");
        registry.add("wechat.miniprogram.api-base-url", MOCK::baseUrl);
        registry.add("wechat.miniprogram.app-id", () -> "wx-integration-test-app-id");
        registry.add("wechat.miniprogram.app-secret", () -> "integration-test-secret-not-real");
    }

    @AfterAll
    static void stopMock() {
        MOCK.close();
    }

    @Test
    void 用户映射失败_500且不签发会话() throws Exception {
        MOCK.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok(
                "{\"openid\":\"dev-user-1\",\"session_key\":\"sk-map-fail\"}"));
        when(userRepository.findByOpenid(anyString())).thenReturn(Optional.empty());
        org.mockito.Mockito.doThrow(new DataAccessResourceFailureException("db down"))
                .when(userRepository).insert(anyString(), anyString(), anyString(), any(Instant.class));
        int before = sessionCount();

        String body = login()
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("accessToken");
        assertThat(body).doesNotContain("db down");
        assertThat(sessionCount()).as("映射失败时不得留下可用的伪造会话").isEqualTo(before);
    }

    @Test
    void 会话签发失败_500且不下发可用令牌() throws Exception {
        MOCK.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok(
                "{\"openid\":\"dev-user-1\",\"session_key\":\"sk-issue-fail\"}"));
        // 映射成功（已有用户），失败发生在签发环节
        when(userRepository.findByOpenid(anyString())).thenReturn(Optional.of(new UserRepository.UserRow(
                "u-dev-user-1", "dev-user-1", null, null, false, "开发用户甲", null,
                "ACTIVE", 1, Instant.now(), null)));
        // N10 后 issueSession 签发前先查账号状态（DELETION_PENDING → 403）；本测试用 ACTIVE 映射，
        // 让失败仍发生在 authSessionStore.issue（500 失败面语义不变）
        when(userRepository.findById(anyString())).thenReturn(Optional.of(new UserRepository.UserRow(
                "u-dev-user-1", "dev-user-1", null, null, false, "开发用户甲", null,
                "ACTIVE", 1, Instant.now(), null)));
        when(authSessionStore.issue(anyString()))
                .thenThrow(new DataAccessResourceFailureException("auth_sessions unavailable"));
        int before = sessionCount();

        String body = login()
                .andExpect(status().isInternalServerError())
                .andExpect(jsonPath("$.code").value("INTERNAL_ERROR"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("accessToken");
        assertThat(body).doesNotContain("auth_sessions unavailable");
        assertThat(sessionCount()).isEqualTo(before);
    }

    private org.springframework.test.web.servlet.ResultActions login() throws Exception {
        return mockMvc.perform(post("/api/v1/auth/wechat/login")
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Client-Version", "1.0.0")
                .header("X-Platform", "wechat-miniprogram")
                .content("{\"code\":\"code-map-or-issue\",\"consentVersion\":\"v1.0\"}"));
    }

    private int sessionCount() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM auth_sessions", Integer.class);
        return count == null ? 0 : count;
    }
}
