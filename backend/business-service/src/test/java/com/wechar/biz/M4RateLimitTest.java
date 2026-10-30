package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

/**
 * M4 限流测试（08B §M4「限流」+ 契约 12 条 '429' 声明路径）。
 *
 * 专属上下文：login-per-window=2、window-seconds=3600（窗口不跨测试边界，
 * 避免固定窗口翻转造成的 flake）。
 *
 * 隔离手段：登录类限流键 = 客户端 IP → 每个测试用**不同 remoteAddr**
 * （登录类测试互相独立，也与共享 itest 上下文的其他 119+ 用例独立）。
 *
 * 断言矩阵：
 *  1. 契约 429 路径（登录）超阈值 → 429 + RATE_LIMITED + Retry-After + retryable=true；
 *  2. 未声明 429 的路径（GET /departments）不受影响（不发明契约外语义）；
 *  3. 限流态信封形状稳定（只 200/429，429 信封字段齐全，无 200+空对象类退化）。
 * 与网关 429（D 侧 rateLimit，默认关）口径一致：同 code、同头。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4rltest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.rate-limit.login-per-window=2",
        "app.rate-limit.submit-per-window=3",
        "app.rate-limit.window-seconds=3600"
})
@AutoConfigureMockMvc
class M4RateLimitTest {

    @Autowired
    private MockMvc mockMvc;

    private static final String LOGIN_BODY =
            "{\"code\":\"dev-code-rl\",\"consentVersion\":\"v1\"}";

    /** 登录请求：以指定 remoteAddr 触发（登录类限流键 = IP）。 */
    private MockHttpServletRequestBuilder loginFrom(String ip) {
        return post("/api/v1/auth/wechat/login")
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Client-Version", "dev")
                .header("X-Platform", "wechat-miniprogram")
                .content(LOGIN_BODY)
                .with(req -> {
                    req.setRemoteAddr(ip);
                    return req;
                });
    }

    @Test
    void 登录超阈值_429_RATE_LIMITED_带RetryAfter() throws Exception {
        String ip = "10.9.4.11"; // 本测试专属 IP → 独立计数窗口
        for (int i = 0; i < 2; i++) {
            mockMvc.perform(loginFrom(ip)).andExpect(status().isOk());
        }
        mockMvc.perform(loginFrom(ip))
                .andExpect(status().isTooManyRequests())
                .andExpect(jsonPath("$.code").value("RATE_LIMITED"))
                .andExpect(jsonPath("$.retryable").value(true))
                .andExpect(jsonPath("$.requestId").isNotEmpty())
                .andExpect(header().string("Retry-After", org.hamcrest.Matchers.matchesRegex("\\d+")));
    }

    @Test
    void 未声明429的路径_不受限流影响() throws Exception {
        // GET /departments 契约无 429 → 连续访问不被拦（即便同 IP 登录窗口已用尽）
        String ip = "10.9.4.12";
        for (int i = 0; i < 2; i++) { // 阈值 = 2：窗口用尽
            mockMvc.perform(loginFrom(ip)).andExpect(status().isOk());
        }
        mockMvc.perform(loginFrom(ip)).andExpect(status().isTooManyRequests()); // 确认窗口已用尽
        for (int i = 0; i < 5; i++) {
            mockMvc.perform(get("/api/v1/departments")
                            .with(req -> {
                                req.setRemoteAddr(ip);
                                return req;
                            }))
                    .andExpect(status().isOk());
        }
    }

    @Test
    void 限流命中_信封形状稳定_无200空对象退化() throws Exception {
        String ip = "10.9.4.13";
        for (int i = 0; i < 5; i++) {
            mockMvc.perform(loginFrom(ip)).andExpect(result -> {
                int st = result.getResponse().getStatus();
                org.assertj.core.api.Assertions.assertThat(st)
                        .as("登录限流态只应是 200 或 429，实际 %s", st)
                        .isIn(200, 429);
                if (st == 429) {
                    String body = result.getResponse()
                            .getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
                    org.assertj.core.api.Assertions.assertThat(body)
                            .contains("\"code\":\"RATE_LIMITED\"")
                            .contains("\"retryable\":true")
                            .contains("\"serverTime\"");
                }
            });
        }
    }
}
