package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 生产档<b>凭证缺失</b>时的登录语义（真跑生产 Provider，不做任何 mock 上游调用）。
 *
 * <p>要求：显式 503（依赖未就绪）而非 500，retryable=false，绝不回退到模拟登录/
 * 固定用户/开发 Token，也不下发任何会话。</p>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=prodtest",
        "app.rate-limit.enabled=false",
        "app.audit.enabled=false",
        // 故意只配 AppID、不配 AppSecret：生产 Provider 必须显式失败
        "wechat.miniprogram.app-id=wx-configured-but-secret-missing",
        "wechat.miniprogram.app-secret="
})
@AutoConfigureMockMvc
class M5WechatLoginNotConfiguredTest {

    private static final String H2_URL =
            "jdbc:h2:mem:m5wechatnoconf;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                    + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> H2_URL);
        registry.add("spring.datasource.username", () -> "sa");
        registry.add("spring.datasource.password", () -> "");
        registry.add("phone.key-base64", () -> "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
        registry.add("spring.sql.init.mode", () -> "always");
        registry.add("spring.sql.init.encoding", () -> "UTF-8");
        registry.add("spring.sql.init.data-locations", () -> "classpath:db/test-m5-seed.sql");
    }

    @Test
    void 缺少AppSecret_登录503不可重试_且不签发会话() throws Exception {
        int before = sessionCount();

        String body = mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "1.0.0")
                        .header("X-Platform", "wechat-miniprogram")
                        .content("{\"code\":\"any-code\",\"consentVersion\":\"v1.0\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("WECHAT_PROVIDER_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(false))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("accessToken");
        assertThat(body).doesNotContain("app-secret");
        assertThat(sessionCount()).as("配置缺失时不得生成任何会话").isEqualTo(before);
    }

    @Test
    void 缺少AppSecret_医生登录同样503_且不降级为患者() throws Exception {
        int before = sessionCount();

        mockMvc.perform(post("/api/v1/doctor/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "1.0.0")
                        .header("X-Platform", "wechat-miniprogram")
                        .content("{\"code\":\"any-code\",\"consentVersion\":\"v1.0\"}"))
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("WECHAT_PROVIDER_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(false));

        assertThat(sessionCount()).isEqualTo(before);
    }

    private int sessionCount() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM auth_sessions", Integer.class);
        return count == null ? 0 : count;
    }
}
