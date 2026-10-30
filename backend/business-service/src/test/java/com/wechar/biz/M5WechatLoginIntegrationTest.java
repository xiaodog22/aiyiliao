package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.auth.MockWechatServer;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 生产微信登录<b>完整链路</b>集成测试（H2 + 本地受控微信 mock + 生产档 Provider + strict 鉴权）。
 *
 * <p>链路：{@code POST /api/v1/auth/wechat/login} → {@link com.wechar.biz.auth.ProdWechatSessionProvider}
 * 真实 HTTP 调 mock 的 code2session → 现有用户映射（users/user_profiles）→ 现有会话签发
 * （auth_sessions，库内只存哈希）→ 用签发的 Bearer 访问受保护接口。</p>
 *
 * <p><b>边界</b>：upstream 是本地 mock，凭证是测试假值；本测试证明的是"代码链路正确"，
 * <b>不</b>等于真实微信联调通过。</p>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=prodtest",
        "app.rate-limit.enabled=false",
        "app.audit.enabled=false"
})
@AutoConfigureMockMvc
class M5WechatLoginIntegrationTest {

    private static final String H2_URL =
            "jdbc:h2:mem:m5wechatlogin;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                    + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1";
    private static final String APP_SECRET = "integration-test-secret-not-real";

    private static final MockWechatServer MOCK = startMock();

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

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
        registry.add("wechat.miniprogram.app-secret", () -> APP_SECRET);
        registry.add("wechat.miniprogram.connect-timeout-ms", () -> "2000");
        registry.add("wechat.miniprogram.read-timeout-ms", () -> "2000");
    }

    @AfterAll
    static void stopMock() {
        MOCK.close();
    }

    // ---------------------------------------------------------------- 正常链路

    @Test
    void 患者登录_换码成功_签发会话_受保护接口可用() throws Exception {
        routeOpenid("code-patient-ok", "dev-user-1");

        String body = login("/api/v1/auth/wechat/login", "code-patient-ok")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.tokenType").value("Bearer"))
                .andExpect(jsonPath("$.data.expiresIn").value(org.hamcrest.Matchers.greaterThanOrEqualTo(60)))
                .andExpect(jsonPath("$.data.user.id").value("u-dev-user-1"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        String accessToken = extract(body, "at-");
        assertThat(accessToken).isNotBlank();

        // 受保护接口：会话 Bearer 生效（strict 档，不认 X-User-Id）
        mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("u-dev-user-1"));
        // 库里只存哈希：明文令牌不得出现在 auth_sessions
        Integer plainRows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM auth_sessions WHERE access_token_hash = ?", Integer.class, accessToken);
        assertThat(plainRows).isZero();
    }

    @Test
    void 新用户首次登录_自动建档并签发会话() throws Exception {
        routeOpenid("code-new-user", "brand-new-openid");

        login("/api/v1/auth/wechat/login", "code-new-user")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.user.id").value("u-brand-new-openid"));

        Integer users = jdbc.queryForObject(
                "SELECT COUNT(*) FROM users WHERE wechat_openid = ?", Integer.class, "brand-new-openid");
        assertThat(users).isEqualTo(1);
        Integer profiles = jdbc.queryForObject(
                "SELECT COUNT(*) FROM user_profiles WHERE user_id = ?", Integer.class, "u-brand-new-openid");
        assertThat(profiles).isEqualTo(1);
    }

    @Test
    void 医生登录_角色由服务端任职关系判定_可用医生端接口() throws Exception {
        routeOpenid("code-doctor-ok", "dev-user-2");

        String body = login("/api/v1/doctor/login", "code-doctor-ok")
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.user.id").value("u-dev-user-2"))
                .andExpect(jsonPath("$.data.user.roles", org.hamcrest.Matchers.hasItem("DOCTOR")))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        String accessToken = extract(body, "at-");

        mockMvc.perform(get("/api/v1/doctor/workbench").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isOk());
    }

    @Test
    void 登录响应不泄露session_key_openid字段或AppSecret() throws Exception {
        routeOpenid("code-leak-check", "dev-user-1");

        String body = login("/api/v1/auth/wechat/login", "code-leak-check")
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("session_key");
        assertThat(body).doesNotContain("sessionKey");
        assertThat(body).doesNotContain("\"openid\"");
        assertThat(body).doesNotContain(APP_SECRET);
        assertThat(body).doesNotContain("code-leak-check");
    }

    // ------------------------------------------------------------ 角色权限隔离

    @Test
    void 患者会话_访问医生端接口_403且不泄漏范围() throws Exception {
        routeOpenid("code-patient-forbidden", "dev-user-1");
        String accessToken = extract(login("/api/v1/auth/wechat/login", "code-patient-forbidden")
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8), "at-");

        mockMvc.perform(get("/api/v1/doctor/workbench").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
        mockMvc.perform(get("/api/v1/doctor/appointments").header("Authorization", "Bearer " + accessToken))
                .andExpect(status().isForbidden());
    }

    @Test
    void 非任职账号走医生登录_403且不签发会话() throws Exception {
        routeOpenid("code-not-doctor", "dev-user-1");
        int before = sessionCount();

        String body = login("/api/v1/doctor/login", "code-not-doctor")
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("accessToken");
        assertThat(sessionCount()).as("403 时不得留下可用会话").isEqualTo(before);
    }

    // ---------------------------------------------------------------- 失败路径

    @Test
    void 微信返回code无效_422_且不签发会话() throws Exception {
        MOCK.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":40029,\"errmsg\":\"invalid code\"}"));
        int before = sessionCount();

        String body = login("/api/v1/auth/wechat/login", "code-invalid-40029")
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("WECHAT_CODE_INVALID"))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("accessToken");
        assertThat(sessionCount()).isEqualTo(before);
    }

    @Test
    void 微信返回code已被使用_422_且不签发会话() throws Exception {
        MOCK.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok(
                "{\"errcode\":40163,\"errmsg\":\"code been used\"}"));
        int before = sessionCount();

        login("/api/v1/auth/wechat/login", "code-reused-40163")
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("WECHAT_CODE_INVALID"));
        assertThat(sessionCount()).isEqualTo(before);
    }

    @Test
    void 微信上游不可用_503可重试_且不签发会话() throws Exception {
        MOCK.route("/sns/jscode2session", req -> MockWechatServer.Resp.status(502, "bad gateway"));
        int before = sessionCount();

        String body = login("/api/v1/auth/wechat/login", "code-upstream-down")
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("WECHAT_UPSTREAM_UNAVAILABLE"))
                .andExpect(jsonPath("$.retryable").value(true))
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        assertThat(body).doesNotContain("accessToken");
        assertThat(sessionCount()).isEqualTo(before);
        assertThat(body).doesNotContain(APP_SECRET);
    }

    @Test
    void 微信响应缺openid_503响应异常_不生成伪造会话() throws Exception {
        MOCK.route("/sns/jscode2session", req -> MockWechatServer.Resp.ok("{\"session_key\":\"only-key\"}"));
        int before = sessionCount();

        login("/api/v1/auth/wechat/login", "code-no-openid")
                .andExpect(status().isServiceUnavailable())
                .andExpect(jsonPath("$.code").value("WECHAT_RESPONSE_INVALID"));
        assertThat(sessionCount()).isEqualTo(before);
    }

    // ---------------------------------------------------------------- 辅助

    private org.springframework.test.web.servlet.ResultActions login(String path, String code) throws Exception {
        return mockMvc.perform(post(path)
                .contentType(MediaType.APPLICATION_JSON)
                .header("X-Client-Version", "1.0.0")
                .header("X-Platform", "wechat-miniprogram")
                .content("{\"code\":\"" + code + "\",\"consentVersion\":\"v1.0\"}"));
    }

    /** 按 js_code 返回对应 openid（每个用例自注册，避免用例间顺序耦合）。 */
    private static void routeOpenid(String code, String openid) {
        MOCK.route("/sns/jscode2session", req -> {
            String requested = queryParam(req.query(), "js_code");
            if (!code.equals(requested)) {
                return MockWechatServer.Resp.ok("{\"errcode\":40029,\"errmsg\":\"invalid code\"}");
            }
            return MockWechatServer.Resp.ok(
                    "{\"openid\":\"" + openid + "\",\"session_key\":\"sk-for-" + openid + "\"}");
        });
    }

    private static String queryParam(String query, String name) {
        if (query == null) {
            return null;
        }
        for (String pair : query.split("&")) {
            int eq = pair.indexOf('=');
            if (eq > 0 && name.equals(pair.substring(0, eq))) {
                return java.net.URLDecoder.decode(pair.substring(eq + 1), StandardCharsets.UTF_8);
            }
        }
        return null;
    }

    private int sessionCount() {
        Integer count = jdbc.queryForObject("SELECT COUNT(*) FROM auth_sessions", Integer.class);
        return count == null ? 0 : count;
    }

    private static String extract(String body, String prefix) {
        Matcher m = Pattern.compile("\"(" + Pattern.quote(prefix) + "[^\"]+)\"").matcher(body);
        String found = null;
        while (m.find()) {
            found = m.group(1);
        }
        return found == null ? "" : found;
    }
}
