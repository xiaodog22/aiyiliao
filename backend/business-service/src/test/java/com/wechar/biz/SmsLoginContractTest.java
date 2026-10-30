package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.auth.DevSmsSender;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * N9 短信验证码 + N8 医生账号登录 契约测试（2026-10-19，仿 M4ContractDoctorTest 探针范式）：
 * 逐状态断言实测码 ∈ 契约声明集合（可确定的场景钉死为单一码）。
 *  - N9：200 下发 challengeId/ttlSec · 缺 Idempotency-Key 400 · 手机号/scene 非法 422；
 *  - N8：手机号账号 200 · 工号账号 200（V11 employee_no）· 错码/未知/复用 401 · 非医生 403 ·
 *        参数缺失 400 · 缺 X-Client-Version 400 · X-Platform 非 const 422。
 * 本上下文 app.sms.cooldown-seconds=0（每方法可自由下发）；60s 冷却语义由 SmsCooldownContractTest 覆盖。
 * 验证码经 dev 档 DevSmsSender.lastCode 读取（生产档无此入口）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m8sms;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "app.sms.cooldown-seconds=0",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class SmsLoginContractTest {

    private static final String USER_DOCTOR = "dev-user-2"; // doc-gastro-1 任职
    private static final String USER_PATIENT = "dev-user-1"; // 无医生任职
    private static final String PHONE_DOCTOR = "13900001111";
    private static final String PHONE_PATIENT = "13900002222";
    private static final String EMPLOYEE_NO = "D-0001";
    private static final String PLATFORM = "wechat-miniprogram";
    private static final String CLIENT_VERSION = "1.0.0";

    @Autowired
    private MockMvc mockMvc;
    @Autowired
    private JdbcTemplate jdbc;
    @Autowired
    private DevSmsSender smsSender;

    private final ObjectMapper mapper = new ObjectMapper();

    @BeforeEach
    void setUp() {
        // V11 工号列（测试库幂等赋值）：N8 工号登录路径
        jdbc.update("UPDATE doctors SET employee_no = ? WHERE id = 'doc-gastro-1'", EMPLOYEE_NO);
    }

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

    private static String idem() {
        return "n8n9-" + UUID.randomUUID();
    }

    private MvcResult sendSms(String phone, String scene, boolean withKey) throws Exception {
        var req = post("/api/v1/auth/sms/send")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"phone\":\"" + phone + "\",\"scene\":\"" + scene + "\"}");
        if (withKey) {
            req = req.header("Idempotency-Key", idem());
        }
        return mockMvc.perform(req).andReturn();
    }

    /** 下发并返回 challengeId（200 前提已由调用方探针覆盖）。 */
    private String challenge(String phone) throws Exception {
        MvcResult r = sendSms(phone, "DOCTOR_LOGIN", true);
        if (st(r) != 200) {
            throw new AssertionError("下发失败 status=" + st(r));
        }
        JsonNode node = mapper.readTree(r.getResponse().getContentAsString(StandardCharsets.UTF_8));
        return node.get("data").get("challengeId").asText();
    }

    private MvcResult login(String account, String credential, String challengeId,
                            boolean withIdem, boolean withClientVersion, String platform) throws Exception {
        var req = post("/api/v1/doctor/login-by-account")
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"account\":\"" + account + "\",\"credential\":\"" + credential
                        + "\",\"challengeId\":\"" + challengeId + "\"}");
        if (withIdem) {
            req = req.header("Idempotency-Key", idem());
        }
        if (withClientVersion) {
            req = req.header("X-Client-Version", CLIENT_VERSION);
        }
        if (platform != null) {
            req = req.header("X-Platform", platform);
        }
        return mockMvc.perform(req).andReturn();
    }

    private void bindPhone(String userId, String phone) throws Exception {
        mockMvc.perform(post("/api/v1/auth/phone/bind")
                        .header("X-User-Id", userId)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"phone\":\"" + phone + "\"}"))
                .andExpect(status().isOk());
    }

    private static String wrongCode(String actual) {
        return "999999".equals(actual) ? "999998" : "999999";
    }

    // ---------------------------------------------------------------- N9 sms/send

    @Test
    void smsSend域() throws Exception {
        // 正常下发：200 {challengeId, ttlSec}
        MvcResult ok = sendSms(PHONE_PATIENT, "DOCTOR_LOGIN", true);
        probe("POST /api/v1/auth/sms/send", st(ok), 200);
        JsonNode node = mapper.readTree(ok.getResponse().getContentAsString(StandardCharsets.UTF_8));
        probe("POST /api/v1/auth/sms/send.data", node.get("data").has("challengeId")
                && node.get("data").get("ttlSec").asInt() == 300 ? 200 : 500, 200);

        // 缺 Idempotency-Key（契约参数 required）→ 400
        probe("POST /api/v1/auth/sms/send(缺幂等键)", st(sendSms(PHONE_PATIENT, "DOCTOR_LOGIN", false)), 400);

        // 手机号格式非法 → 422（@Pattern 契约 pattern）
        probe("POST /api/v1/auth/sms/send(手机号非法)", st(sendSms("12345", "DOCTOR_LOGIN", true)), 422);

        // scene 非 const DOCTOR_LOGIN → 422
        probe("POST /api/v1/auth/sms/send(scene非法)", st(sendSms(PHONE_PATIENT, "OTHER", true)), 422);
    }

    // ---------------------------------------------------------------- N8 login-by-account

    @Test
    void loginByAccount域() throws Exception {
        bindPhone(USER_DOCTOR, PHONE_DOCTOR);
        bindPhone(USER_PATIENT, PHONE_PATIENT);

        // 参数缺失（body 无 credential）→ 400（契约 400 参数缺失）
        MvcResult missingField = mockMvc.perform(post("/api/v1/doctor/login-by-account")
                .header("X-Client-Version", CLIENT_VERSION)
                .header("X-Platform", PLATFORM)
                .header("Idempotency-Key", idem())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"account\":\"" + PHONE_DOCTOR + "\",\"challengeId\":\"x\"}"))
                .andReturn();
        probe("POST /api/v1/doctor/login-by-account(缺字段)", st(missingField), 400);

        // 缺 Idempotency-Key → 400
        probe("POST /api/v1/doctor/login-by-account(缺幂等键)",
                st(login(PHONE_DOCTOR, "123456", "x", false, true, PLATFORM)), 400);

        // 缺 X-Client-Version → 400（契约 required 头）
        probe("POST /api/v1/doctor/login-by-account(缺版本头)",
                st(login(PHONE_DOCTOR, "123456", "x", true, false, PLATFORM)), 400);

        // X-Platform 非 const → 422
        probe("POST /api/v1/doctor/login-by-account(平台非const)",
                st(login(PHONE_DOCTOR, "123456", "x", true, true, "ios")), 422);

        // 未知 challengeId → 401
        probe("POST /api/v1/doctor/login-by-account(未知challenge)",
                st(login(PHONE_DOCTOR, "123456", "sms-not-exists", true, true, PLATFORM)), 401);

        // 手机号账号：错码 401 → 正确码 200（同 challenge，attempts<5）→ 复用 401（一次性）
        String c1 = challenge(PHONE_DOCTOR);
        String code1 = smsSender.lastCode(PHONE_DOCTOR);
        probe("POST /api/v1/doctor/login-by-account(错码)",
                st(login(PHONE_DOCTOR, wrongCode(code1), c1, true, true, PLATFORM)), 401);
        MvcResult okPhone = login(PHONE_DOCTOR, code1, c1, true, true, PLATFORM);
        probe("POST /api/v1/doctor/login-by-account(手机号账号)", st(okPhone), 200, 401, 403);
        if (st(okPhone) == 200) {
            JsonNode node = mapper.readTree(okPhone.getResponse().getContentAsString(StandardCharsets.UTF_8));
            if (!node.get("data").has("accessToken") || !node.get("data").get("user").get("roles").toString().contains("DOCTOR")) {
                throw new AssertionError("OkSession 结构或医生角色缺失: " + node);
            }
        }
        probe("POST /api/v1/doctor/login-by-account(challenge复用)",
                st(login(PHONE_DOCTOR, code1, c1, true, true, PLATFORM)), 401);

        // 工号账号（V11 employee_no 路径）：新 challenge → 200
        String c2 = challenge(PHONE_DOCTOR);
        String code2 = smsSender.lastCode(PHONE_DOCTOR);
        probe("POST /api/v1/doctor/login-by-account(工号账号)",
                st(login(EMPLOYEE_NO, code2, c2, true, true, PLATFORM)), 200, 401, 403);

        // 非医生角色（手机号账号 + 有效验证码）→ 403（契约声明 403）
        String c3 = challenge(PHONE_PATIENT);
        String code3 = smsSender.lastCode(PHONE_PATIENT);
        probe("POST /api/v1/doctor/login-by-account(非医生)",
                st(login(PHONE_PATIENT, code3, c3, true, true, PLATFORM)), 403);
    }
}
