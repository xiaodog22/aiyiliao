package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.auth.DevSmsSender;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * N10 账号注销 + N11 撤回授权 + F7/F8 字段 契约测试（2026-10-19，仿 M4ContractDoctorTest 探针范式）。
 *  - N10：409 未完成预约 · 400 缺幂等键 · 422 缺字段/二次校验失败 · 200 软删（status=DELETION_PENDING
 *    且 30 天冷静期落库）· 旧会话 401 · 冷静期内再登录 403；
 *  - N11：授权后撤回 200 + WITHDRAWN 落库 · 同键重放 200 · 同键异载荷 409 · scope 非法 422 · 缺键 400；
 *  - F7：登录 consentVersion 记入 users.login_consent_version；F8：绑定后 /me 返回 138****1234 掩码。
 * 方法间用不同用户隔离（注销改 dev-user-2 状态；F7/F8/409/撤回均不依赖 dev-user-2），顺序无关。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m1011;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "app.sms.cooldown-seconds=0",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class AccountLifecycleContractTest {

    private static final String USER_PATIENT = "dev-user-1"; // 有未完成预约（409 场景）+ 撤回场景
    private static final String USER_DOCTOR = "dev-user-2";   // 无未完成业务（成功注销场景）
    private static final String PHONE_DOCTOR = "13900006666";
    private static final String PHONE_PATIENT = "13900007777";
    private static final String PLATFORM = "wechat-miniprogram";
    private static final String CLIENT_VERSION = "1.0.0";

    @Autowired
    private MockMvc mockMvc;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private DevSmsSender smsSender;

    private final ObjectMapper mapper = new ObjectMapper();

    // ---------------------------------------------------------------- 基础设施

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

    private static String body(MvcResult result) throws Exception {
        return result.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static String idem() {
        return "n1011-" + UUID.randomUUID();
    }

    private void bindPhone(String userId, String phone) throws Exception {
        mockMvc.perform(post("/api/v1/auth/phone/bind")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\"}"))
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers.status().isOk());
    }

    /** N9 下发（scene 可选）并返回 challengeId。 */
    private String sendChallenge(String phone, String scene) throws Exception {
        MvcResult r = mockMvc.perform(post("/api/v1/auth/sms/send")
                        .header("Idempotency-Key", idem())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\",\"scene\":\"" + scene + "\"}"))
                .andReturn();
        if (st(r) != 200) {
            throw new AssertionError("短信下发失败 status=" + st(r) + " body=" + body(r));
        }
        return mapper.readTree(body(r)).get("data").get("challengeId").asText();
    }

    private MvcResult deleteAccount(String challengeId, String code, String idemKey,
                                    String bearer, String xUser) throws Exception {
        var req = delete("/api/v1/user/account")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"challengeId\":\"" + challengeId + "\",\"code\":\"" + code + "\"}");
        if (idemKey != null) {
            req = req.header("Idempotency-Key", idemKey);
        }
        if (bearer != null) {
            req = req.header("Authorization", "Bearer " + bearer);
        }
        if (xUser != null) {
            req = req.header("X-User-Id", xUser);
        }
        return mockMvc.perform(req).andReturn();
    }

    // ---------------------------------------------------------------- N10 注销

    @Test
    void 账号注销域() throws Exception {
        // 400：缺 Idempotency-Key（契约参数 required）
        probe("DELETE /api/v1/user/account(缺幂等键)",
                st(deleteAccount("x", "123456", null, null, USER_PATIENT)), 400);

        // 409：dev-user-1 存在未完成预约（PENDING），在校验码之前拦截
        probe("DELETE /api/v1/user/account(未完成预约)",
                st(deleteAccount("x", "123456", idem(), null, USER_PATIENT)), 409);

        // 422：body 缺 code 字段（bean validation）
        probe("DELETE /api/v1/user/account(缺code)",
                st(mockMvc.perform(delete("/api/v1/user/account")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", idem())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"challengeId\":\"x\"}")).andReturn()), 422);

        // ---- 成功链（dev-user-2：无未完成业务）：绑手机 → 登录(F7) → 验证码 → 注销 → 会话失效 → 再登录 403
        bindPhone(USER_DOCTOR, PHONE_DOCTOR);
        MvcResult login = mockMvc.perform(post("/api/v1/auth/wechat/login")
                .header("X-Client-Version", CLIENT_VERSION)
                .header("X-Platform", PLATFORM)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"code\":\"dev-user-2-code\",\"consentVersion\":\"v9.9\"}"))
                .andReturn();
        probe("POST /api/v1/auth/wechat/login(F7前置)", st(login), 200, 400, 403, 422, 429, 503);
        String accessToken = mapper.readTree(body(login)).get("data").get("accessToken").asText();

        // F7：登录携带的同意版本已落 users.login_consent_version（合规审计）
        String recorded = jdbc.queryForObject(
                "SELECT login_consent_version FROM users WHERE id = 'u-dev-user-2'", String.class);
        if (!"v9.9".equals(recorded)) {
            throw new AssertionError("F7 login_consent_version 未记录，实际=" + recorded);
        }

        String challengeId = sendChallenge(PHONE_DOCTOR, "ACCOUNT_DELETION");
        String code = smsSender.lastCode(PHONE_DOCTOR);

        // 422：验证码错误（二次校验失败）
        probe("DELETE /api/v1/user/account(错码)",
                st(deleteAccount(challengeId, "000000".equals(code) ? "999999" : "000000",
                        idem(), accessToken, null)), 422);

        // 200：正确验证码 → 软删 + 会话撤销
        MvcResult ok = deleteAccount(challengeId, code, idem(), accessToken, null);
        probe("DELETE /api/v1/user/account", st(ok), 200, 401, 409, 422);
        if (st(ok) == 200 && !mapper.readTree(body(ok)).get("data").get("ok").asBoolean()) {
            throw new AssertionError("data.ok 应为 true: " + body(ok));
        }

        // 红线断言：软删落库 + 30 天冷静期（不物理删库）
        var row = jdbc.queryForMap("SELECT status, deletion_requested_at, deletion_effective_at "
                + "FROM users WHERE id = 'u-dev-user-2'");
        if (!"DELETION_PENDING".equals(row.get("status")) || row.get("deletion_effective_at") == null) {
            throw new AssertionError("软删未落库（status/cool-down）: " + row);
        }
        long cooldownDays = java.time.Duration.between(
                ((java.sql.Timestamp) row.get("deletion_requested_at")).toInstant(),
                ((java.sql.Timestamp) row.get("deletion_effective_at")).toInstant()).toDays();
        if (cooldownDays != 30) {
            throw new AssertionError("冷静期应为 30 天，实际 " + cooldownDays);
        }

        // 旧会话已撤销 → 401（受保护路径仅带失效 Bearer）
        probe("GET /api/v1/me(注销后旧会话)",
                st(mockMvc.perform(get("/api/v1/me").header("Authorization", "Bearer " + accessToken))
                        .andReturn()), 401);

        // 冷静期内不可再次登录 → 403（契约 wechatLogin 声明 403）
        probe("POST /api/v1/auth/wechat/login(冷静期内)",
                st(mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .header("X-Platform", PLATFORM)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"code\":\"dev-user-2-code\",\"consentVersion\":\"v9.9\"}"))
                        .andReturn()), 403);
    }

    // ---------------------------------------------------------------- N11 撤回 + F8

    @Test
    void 授权撤回与掩码字段域() throws Exception {
        // F8：绑定手机号后 /me 返回 138****7777 掩码（未绑定时字段省略）
        bindPhone(USER_PATIENT, PHONE_PATIENT);
        MvcResult me = mockMvc.perform(get("/api/v1/me")
                .header("X-User-Id", USER_PATIENT)).andReturn();
        probe("GET /api/v1/me(F8)", st(me), 200, 401, 503);
        String masked = mapper.readTree(body(me)).get("data").path("maskedPhone").asText(null);
        if (!"139****7777".equals(masked)) {
            throw new AssertionError("F8 maskedPhone 应为 139****7777，实际=" + masked);
        }

        // 400：缺幂等键
        probe("POST /api/v1/user/auth/revoke(缺幂等键)",
                st(mockMvc.perform(post("/api/v1/user/auth/revoke")
                        .header("X-User-Id", USER_PATIENT)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"HEALTH_RECORDS\"}")).andReturn()), 400);

        // 422：scope 非法（@Pattern）
        probe("POST /api/v1/user/auth/revoke(scope非法)",
                st(mockMvc.perform(post("/api/v1/user/auth/revoke")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", idem())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"OTHER\"}")).andReturn()), 422);

        String key = idem();
        // 200：撤回 HEALTH_RECORDS（种子已 GRANTED HEALTH_DATA_PROCESSING → 追加 WITHDRAWN）
        MvcResult revoke = mockMvc.perform(post("/api/v1/user/auth/revoke")
                .header("X-User-Id", USER_PATIENT)
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"scope\":\"HEALTH_RECORDS\"}")).andReturn();
        probe("POST /api/v1/user/auth/revoke", st(revoke), 200, 400, 401, 409, 422);
        if (st(revoke) == 200 && !mapper.readTree(body(revoke)).get("data").get("revoked").asBoolean()) {
            throw new AssertionError("data.revoked 应为 true: " + body(revoke));
        }
        Integer withdrawn = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consents WHERE user_id = 'u-dev-user-1' "
                        + "AND purpose = 'HEALTH_DATA_PROCESSING' AND status = 'WITHDRAWN'",
                Integer.class);
        if (withdrawn == null || withdrawn < 1) {
            throw new AssertionError("撤回未以 WITHDRAWN 行落库（只追加红线）");
        }

        // 同键同载荷 → 重放 200（不追加新行）
        int rowsBefore = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consents WHERE user_id = 'u-dev-user-1'", Integer.class);
        probe("POST /api/v1/user/auth/revoke(同键重放)",
                st(mockMvc.perform(post("/api/v1/user/auth/revoke")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"HEALTH_RECORDS\"}")).andReturn()), 200);
        int rowsAfter = jdbc.queryForObject(
                "SELECT COUNT(*) FROM consents WHERE user_id = 'u-dev-user-1'", Integer.class);
        if (rowsAfter != rowsBefore) {
            throw new AssertionError("同键重放不应追加同意行");
        }

        // 同键异载荷 → 409（契约已声明 409）
        probe("POST /api/v1/user/auth/revoke(同键异载荷)",
                st(mockMvc.perform(post("/api/v1/user/auth/revoke")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"FAMILY\"}")).andReturn()), 409);

        // 从未授意的 scope（FAMILY_PROXY 无记录）→ 幂等终态 200
        probe("POST /api/v1/user/auth/revoke(从未授意)",
                st(mockMvc.perform(post("/api/v1/user/auth/revoke")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", idem())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":\"FAMILY\"}")).andReturn()), 200);
    }
}
