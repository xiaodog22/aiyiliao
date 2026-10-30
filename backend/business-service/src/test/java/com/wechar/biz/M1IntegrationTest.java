package com.wechar.biz;

import static org.hamcrest.Matchers.hasSize;
import static org.hamcrest.Matchers.notNullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.patch;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * M1 关键规则集成测试（H2 MySQL 兼容模式，不依赖真实 MySQL）：
 * 覆盖：幂等（同键同体 200 replay / 同键异体 409 / 缺键 400）、号源原子扣减失败路径、
 * 过去时段 422、PATCH version 乐观锁、triage localRuleHits 不降级 + 无命中文本、
 * home 三分支、phone 绑定回环、/me 结构、contents 可见性。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m1test;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class M1IntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    private static final String DEV_KEY = "m1-test-key-0001";

    /** 从信封中提取 data.id（取最后一个 ap-/fm-/hr- 主键，创建响应即含新资源）。 */
    private static String extractId(String body, String prefix) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"id\":\"(" + prefix + "[^\"]+)\"").matcher(body);
        String found = null;
        while (m.find()) {
            found = m.group(1);
        }
        return found == null ? "" : found;
    }

    // ---------------------------------------------------------------- auth

    @Test
    void 微信登录_200_返回契约Session形状() throws Exception {
        mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "dev")
                        .header("X-Platform", "wechat-miniprogram")
                        .header("X-Request-Id", "m1-test-login-0001")
                        .content("{\"code\":\"dev-code-alpha\",\"consentVersion\":\"v1\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.accessToken").value(
                        org.hamcrest.Matchers.startsWith("at-")))
                .andExpect(jsonPath("$.data.refreshToken").value(
                        org.hamcrest.Matchers.startsWith("rt-")))
                .andExpect(jsonPath("$.data.expiresIn").value(
                        org.hamcrest.Matchers.greaterThanOrEqualTo(60)))
                .andExpect(jsonPath("$.data.tokenType").value("Bearer"))
                .andExpect(jsonPath("$.data.user.id").value("u-dev-user-1"))
                .andExpect(jsonPath("$.data.user.roles[0]").value("PATIENT"))
                .andExpect(jsonPath("$.data.user.phoneBound").value(false));

        // WechatLoginRequest additionalProperties:false —— 契约外字段 clientType 必须被拒绝
        mockMvc.perform(post("/api/v1/auth/wechat/login")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-Client-Version", "dev")
                        .header("X-Platform", "wechat-miniprogram")
                        .content("{\"code\":\"dev-code-1\",\"consentVersion\":\"v1\",\"clientType\":\"mp\"}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void 手机绑定_密文占位_后四位真实() throws Exception {
        // 用 dev-user-2（种子已绑定状态的用户，不污染 dev-user-1 的未绑定状态）
        mockMvc.perform(post("/api/v1/auth/phone/bind")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .content("{\"phone\":\"13800001111\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.phoneCipher", notNullValue()))
                .andExpect(jsonPath("$.data.phoneLast4").value("1111"))
                .andExpect(jsonPath("$.data.phoneBound").value(true));
    }

    // ---------------------------------------------------------------- me

    @Test
    void me_契约User形状_OkUser() throws Exception {
        mockMvc.perform(get("/api/v1/me").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.id").value("u-dev-user-1"))
                .andExpect(jsonPath("$.data.roles[0]").value("PATIENT"))
                .andExpect(jsonPath("$.data.profileCompleteness").exists())
                .andExpect(jsonPath("$.data.phoneBound").value(false));
        // User additionalProperties:false —— 不得出现契约外字段（profile/preferences 等）
        String body = mockMvc.perform(get("/api/v1/me").header("X-User-Id", "dev-user-1"))
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        org.assertj.core.api.Assertions.assertThat(body)
                .doesNotContain("\"preferences\"")
                .doesNotContain("\"profile\":")
                .doesNotContain("\"user\":");
    }

    @Test
    void 更新profile_乐观锁版本冲突() throws Exception {
        String body = "{\"birthDate\":\"1990-05-01\",\"sex\":\"M\",\"version\":1}";
        mockMvc.perform(patch("/api/v1/me/profile")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.version").value(2));
        mockMvc.perform(patch("/api/v1/me/profile")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content(body))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
    }

    @Test
    void 更新preferences_写库回读() throws Exception {
        mockMvc.perform(put("/api/v1/me/preferences")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"themeMode\":\"DARK\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.themeMode").value("DARK"));
        // GET /me 契约仅返回 User（不含 preferences）；写结果以 PUT 响应为准，
        // 回读冲突路径用陈旧 version 校验乐观锁仍然生效
        mockMvc.perform(put("/api/v1/me/preferences")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"themeMode\":\"DARK\",\"version\":999}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
    }

    // ---------------------------------------------------------------- catalog

    @Test
    void 科室列表_4条() throws Exception {
        mockMvc.perform(get("/api/v1/departments"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(4)));
    }

    @Test
    void 医生与号源() throws Exception {
        mockMvc.perform(get("/api/v1/doctors"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(2)));
        mockMvc.perform(get("/api/v1/doctors/doc-gastro-1/slots"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(3)));
        mockMvc.perform(get("/api/v1/doctors/not-exist/slots"))
                .andExpect(status().isNotFound());
    }

    // ---------------------------------------------------------------- appointment

    @Test
    void 创建预约_幂等_同键同体200重放_异体409_缺键400() throws Exception {
        String body = "{\"slotId\":\"slot-future-1\",\"patientName\":\"张三\",\"symptomSummary\":\"胃胀\"}";
        // 共享上下文内其他测试也消耗同号源：取基线，只断言"恰好扣 1 次"的相对变化
        int before = jdbc.queryForObject(
                "SELECT remaining FROM doctor_slots WHERE id = 'slot-future-1'", Integer.class);

        // 缺键 → 400
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 首次 → 200，replayed=false，响应头 Idempotency-Replayed: false
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", DEV_KEY)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "false"))
                .andExpect(jsonPath("$.data.status").value("PENDING"))
                .andExpect(jsonPath("$.data.replayed").value(false))
                .andExpect(jsonPath("$.data.version").value(1));

        // 同键同体 → 200 重放，响应头 true，data.replayed=true，返回原资源
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", DEV_KEY)
                        .content(body))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.replayed").value(true));

        // 同键异体 → 409 IDEMPOTENCY_KEY_REUSE
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", DEV_KEY)
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"李四\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));

        // 幂等重放不重复扣号：三连调（首次 200 / 同体重放 200 / 异体 409）后 remaining 只减 1
        int after = jdbc.queryForObject(
                "SELECT remaining FROM doctor_slots WHERE id = 'slot-future-1'", Integer.class);
        org.assertj.core.api.Assertions.assertThat(after).isEqualTo(before - 1);
    }

    @Test
    void 号源已满_原子扣减失败_409_SLOT_FULL() throws Exception {
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-test-key-0002")
                        .content("{\"slotId\":\"slot-full-1\",\"patientName\":\"王五\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("SLOT_FULL"));
    }

    @Test
    void 过去时段_422_SLOT_IN_PAST() throws Exception {
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-test-key-0003")
                        .content("{\"slotId\":\"slot-past-1\",\"patientName\":\"赵六\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("SLOT_IN_PAST"));
    }

    @Test
    void PATCH预约_version乐观锁_冲突409() throws Exception {
        // 用独立幂等键创建一条，并从创建响应提取新预约 ID（列表顺序不保证新预约位置）
        String created = mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-test-key-0004")
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"钱七\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String id = extractId(created, "ap-");
        org.assertj.core.api.Assertions.assertThat(id).startsWith("ap-");

        mockMvc.perform(patch("/api/v1/appointments/" + id)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"version\":1,\"symptomSummary\":\"更新后的主诉\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.version").value(2));

        mockMvc.perform(patch("/api/v1/appointments/" + id)
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"version\":1,\"symptomSummary\":\"再次更新\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
    }

    @Test
    void 预约统计_三计数() throws Exception {
        mockMvc.perform(get("/api/v1/appointments/stats").header("X-User-Id", "dev-user-2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.upcoming").value(1))
                .andExpect(jsonPath("$.data.completed").value(0))
                .andExpect(jsonPath("$.data.cancelled").value(0));
    }

    // ---------------------------------------------------------------- triage

    @Test
    void triage_localRuleHits非空_强制急症不降级() throws Exception {
        mockMvc.perform(post("/api/v1/triage")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"symptoms\":\"只是有点累\",\"localRuleHits\":[\"chest_pain\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(true))
                .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"))
                .andExpect(jsonPath("$.data.safety.provenance").value("RULE_RESULT"))
                .andExpect(jsonPath("$.data.safety.ruleSetVersion").value("TRIAGE-RULES-001"))
                .andExpect(jsonPath("$.data.limitations").value(org.hamcrest.Matchers.containsString("不构成诊断")))
                .andExpect(jsonPath("$.data.guidance").value(org.hamcrest.Matchers.containsString("120")));
    }

    @Test
    void triage_无红旗_推荐落到真实科室() throws Exception {
        mockMvc.perform(post("/api/v1/triage")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"symptoms\":\"这两天胃胀反酸消化不太好\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(false))
                .andExpect(jsonPath("$.data.safety.level").value("INFO"))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].departmentId").value("dep-gastro"))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].provenance").value("RULE_RESULT"))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].confidence")
                        .value(org.hamcrest.Matchers.allOf(
                                org.hamcrest.Matchers.greaterThanOrEqualTo(0.6),
                                org.hamcrest.Matchers.lessThanOrEqualTo(0.9))))
                .andExpect(jsonPath("$.data.limitations", notNullValue()));
    }

    @Test
    void triage_文本命中急症红旗() throws Exception {
        mockMvc.perform(post("/api/v1/triage")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"symptoms\":\"突然胸口压榨样疼痛喘不上气\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(true))
                .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"));
    }

    /** 08F T1 / ⑨ 验收输入：口语「肚子疼」经归一层命中消化内科（缺口-1 回归）。 */
    @Test
    void triage_口语肚子疼_归一后推荐消化内科() throws Exception {
        mockMvc.perform(post("/api/v1/triage")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"symptoms\":\"肚子疼\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(false))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].departmentId").value("dep-gastro"))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].departmentName").value("消化内科"))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].provenance").value("RULE_RESULT"));
    }

    /** 08F §4b：口语 + 便血红旗 → emergency=true 且主推荐切急诊科（服务端不漏判）。 */
    @Test
    void triage_口语加便血_红旗触发且主推荐急诊科() throws Exception {
        mockMvc.perform(post("/api/v1/triage/recommendations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"symptoms\":\"肚子疼得厉害，还便血\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.safety.emergency").value(true))
                .andExpect(jsonPath("$.data.safety.level").value("EMERGENCY"))
                .andExpect(jsonPath("$.data.recommendedDepartments[0].departmentName").value("急诊科"))
                .andExpect(jsonPath("$.data.guidance").value(org.hamcrest.Matchers.containsString("120")));
    }

    @Test
    void emergencyCheck_两个路径_同一引擎() throws Exception {
        mockMvc.perform(post("/api/v1/triage/emergency-check")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"突然昏迷不醒\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.emergency").value(true))
                .andExpect(jsonPath("$.data.matchedRules[0]").value("coma"));

        mockMvc.perform(post("/api/v1/triage/emergency-checks")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"text\":\"有点失眠\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.emergency").value(false))
                .andExpect(jsonPath("$.data.rulesetVersion").value("TRIAGE-RULES-001"));
    }

    // ---------------------------------------------------------------- home

    @Test
    void home_未绑定手机_BIND_PHONE() throws Exception {
        mockMvc.perform(get("/api/v1/home").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.reminderType").value("BIND_PHONE"))
                .andExpect(jsonPath("$.data.greeting", notNullValue()));
    }

    @Test
    void home_已绑定有预约_UPCOMING_APPOINTMENT带id() throws Exception {
        mockMvc.perform(get("/api/v1/home").header("X-User-Id", "dev-user-2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.reminderType").value("UPCOMING_APPOINTMENT"))
                .andExpect(jsonPath("$.data.appointmentId").value("ap-bound-1"));
    }

    @Test
    void home_已绑定无预约_AI_GUIDANCE() throws Exception {
        mockMvc.perform(get("/api/v1/home").header("X-User-Id", "dev-user-3"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.reminderType").value("AI_GUIDANCE"));
    }

    @Test
    void homeSummary_契约路径_带blocks() throws Exception {
        mockMvc.perform(get("/api/v1/home/summary").header("X-User-Id", "dev-user-2"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.blocks[?(@.kind=='NEXT_APPOINTMENT')].nextAppointment.id")
                        .value("ap-bound-1"))
                .andExpect(jsonPath("$.data.blocks[?(@.kind=='CONTENT_FEED')].contents[0].reviewStatus")
                        .value("APPROVED"));
    }

    // ---------------------------------------------------------------- content

    @Test
    void contents_只返回APPROVED且详情404不可见草稿() throws Exception {
        mockMvc.perform(get("/api/v1/contents"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", hasSize(1)))
                .andExpect(jsonPath("$.data[0].id").value("cont-test-1"))
                .andExpect(jsonPath("$.data[0].reviewStatus").value("APPROVED"));

        mockMvc.perform(get("/api/v1/contents/cont-test-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.body").value("测试正文"));

        mockMvc.perform(get("/api/v1/contents/cont-test-draft"))
                .andExpect(status().isNotFound());
    }

    // ---------------------------------------------------------------- 取消（契约 cancelAppointment）

    @Test
    void 取消预约_终态_重复取消同终态200() throws Exception {
        // 取消测试用独立键创建，并用创建响应提取新预约 ID（列表含历史预约，取值不可靠）
        String created = mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-test-key-0010")
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"取消甲\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String id = extractId(created, "ap-");
        org.assertj.core.api.Assertions.assertThat(id).startsWith("ap-");

        // 缺 Idempotency-Key → 400
        mockMvc.perform(post("/api/v1/appointments/" + id + "/cancel")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"reason\":\"不去了\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 首次取消 → 200 CANCELLED，记录取消原因
        mockMvc.perform(post("/api/v1/appointments/" + id + "/cancel")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-test-key-0011")
                        .content("{\"reason\":\"行程有变\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CANCELLED"))
                .andExpect(jsonPath("$.data.version").value(2));

        // 重复取消（不同键亦然）→ 200 同一终态，不报错（契约：重复取消返回同一终态）
        mockMvc.perform(post("/api/v1/appointments/" + id + "/cancel")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-test-key-0012")
                        .content("{\"reason\":\"再取消一次\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CANCELLED"))
                .andExpect(jsonPath("$.data.version").value(2));

        // 他人预约取消 → 404（不泄露存在性）
        mockMvc.perform(post("/api/v1/appointments/" + id + "/cancel")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "m1-test-key-0013")
                        .content("{}"))
                .andExpect(status().isNotFound());
    }

    // --------------------------------------------------- by-idempotency-key（越权 404）

    @Test
    void 按幂等键查询_本人200_越权404_键长422() throws Exception {
        mockMvc.perform(post("/api/v1/appointments")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-key-recover-01")
                        .content("{\"slotId\":\"slot-future-1\",\"patientName\":\"找回甲\"}"))
                .andExpect(status().isOk());

        // 本人 → 200
        mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/m1-key-recover-01")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("PENDING"));

        // 他人（键本身不构成读取凭证）→ 404
        mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/m1-key-recover-01")
                        .header("X-User-Id", "dev-user-2"))
                .andExpect(status().isNotFound());

        // 不存在的键 → 404
        mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/no-such-key-00000")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isNotFound());

        // 键长 <8 → 422
        mockMvc.perform(get("/api/v1/appointments/by-idempotency-key/short")
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isUnprocessableEntity());
    }

    // --------------------------------------------------- resources/manifest（禁用项）

    @Test
    void manifest_契约形状_无JS_WXML_红旗词表() throws Exception {
        mockMvc.perform(get("/api/v1/resources/manifest")
                        .param("platform", "wechat-miniprogram")
                        .param("clientVersion", "1.0.0"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.manifestVersion").exists())
                .andExpect(jsonPath("$.data.items").isNotEmpty())
                .andExpect(jsonPath("$.data.items[0].key").exists())
                // 契约约束是「level ∈ A|B、mime ∈ 图片白名单」，不是某个具体条目：
                // V15 引入 delivery 后清单只剩 remote 资源，首条已由 png 变为 jpeg。
                // 断言具体条目会让分类策略调整就误报，这里按契约维度校验。
                .andExpect(jsonPath("$.data.items[0].level",
                        org.hamcrest.Matchers.oneOf("A", "B")))
                .andExpect(jsonPath("$.data.items[0].mime",
                        org.hamcrest.Matchers.oneOf("image/png", "image/jpeg", "image/webp")));

        String body = mockMvc.perform(get("/api/v1/resources/manifest"))
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        // sha256 恰 64 位小写十六进制（契约 minLength/maxLength=64）
        org.assertj.core.api.Assertions.assertThat(
                java.util.regex.Pattern.compile("\"sha256\":\"([0-9a-f]{64})\"").matcher(body).find())
                .as("清单条目 sha256 必须为 64 位小写十六进制")
                .isTrue();
        String lower = body.toLowerCase(java.util.Locale.ROOT);
        org.assertj.core.api.Assertions.assertThat(lower)
                .doesNotContain(".js").doesNotContain(".wxml").doesNotContain(".wxss")
                .doesNotContain("redflag").doesNotContain("red_flag")
                .doesNotContain("红旗").doesNotContain("javascript");

        // platform const 校验：非 wechat-miniprogram → 422
        mockMvc.perform(get("/api/v1/resources/manifest").param("platform", "web"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    // --------------------------------------------------- patient 域（health-records 权限）

    @Test
    void 健康档案_本人CRUD_未授权代成员操作404() throws Exception {
        // 建档（本人）→ 200
        mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-health-key-01")
                        .content("{\"category\":\"VITALS\",\"title\":\"血压\",\"recordedAt\":\"2026-10-01T08:00:00Z\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.category").value("VITALS"))
                .andExpect(jsonPath("$.data.version").value(1));

        // 列表（本人）
        mockMvc.perform(get("/api/v1/health-records").header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].id").value(
                        org.hamcrest.Matchers.startsWith("hr-")));

        // 添加家庭成员 → proxyStatus=NONE（添加 ≠ 授权）
        String memberBody = mockMvc.perform(post("/api/v1/family-members")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-family-key-01")
                        .content("{\"displayName\":\"老王\",\"relation\":\"父亲\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.proxyStatus").value("NONE"))
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String memberId = extractId(memberBody, "fm-");
        org.assertj.core.api.Assertions.assertThat(memberId).startsWith("fm-");

        // 未 GRANTED 代成员列档案 → 404（契约：无有效授权返回 404）
        mockMvc.perform(get("/api/v1/health-records")
                        .param("familyMemberId", memberId)
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("FAMILY_MEMBER_NOT_FOUND"));

        // 未 GRANTED 代成员建档 → 404
        mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-health-key-02")
                        .content("{\"familyMemberId\":\"" + memberId + "\",\"category\":\"VITALS\","
                                + "\"title\":\"代测\",\"recordedAt\":\"2026-10-01T09:00:00Z\"}"))
                .andExpect(status().isNotFound());

        // 模拟邀请被接受后服务端授权（GRANTED 由接受流程写入；此处直写以测授权后放行）
        jdbc.update("UPDATE family_members SET proxy_status = 'GRANTED' WHERE id = ? AND user_id = ?",
                memberId, "u-dev-user-1");
        mockMvc.perform(get("/api/v1/health-records")
                        .param("familyMemberId", memberId)
                        .header("X-User-Id", "dev-user-1"))
                .andExpect(status().isOk());

        // 别人的成员 ID（dev-user-2 无此成员）→ 404
        mockMvc.perform(get("/api/v1/health-records")
                        .param("familyMemberId", memberId)
                        .header("X-User-Id", "dev-user-2"))
                .andExpect(status().isNotFound());
    }

    @Test
    void 邀请_令牌仅返回一次_库内只存哈希_不授予权限() throws Exception {
        // 先添加一名成员（本测试自建，避免与其他测试的 GRANTED 状态互相影响）
        String memberBody = mockMvc.perform(post("/api/v1/family-members")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-family-key-02")
                        .content("{\"displayName\":\"小张\",\"relation\":\"女儿\"}"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String memberId = extractId(memberBody, "fm-");

        String body = mockMvc.perform(post("/api/v1/family-members/invitations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m1-invite-key-01")
                        .content("{\"relation\":\"母亲\",\"channel\":\"QRCODE\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.token", notNullValue()))
                .andExpect(jsonPath("$.data.expiresAt", notNullValue()))
                .andReturn().getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String token = body.replaceAll(".*\"token\":\"([^\"]+)\".*", "$1");
        org.assertj.core.api.Assertions.assertThat(token).startsWith("inv-");

        // 库内无明文 token，只有 64 位小写 SHA-256
        String stored = jdbc.queryForObject(
                "SELECT token_hash FROM family_invitations ORDER BY created_at DESC LIMIT 1",
                String.class);
        org.assertj.core.api.Assertions.assertThat(stored).matches("[0-9a-f]{64}");
        org.assertj.core.api.Assertions.assertThat(stored).isNotEqualTo(token);
        org.assertj.core.api.Assertions.assertThat(stored).doesNotContain(token);

        // 邀请创建不授予该成员代理权限（添加/邀请 ≠ 授权）
        String proxyStatus = jdbc.queryForObject(
                "SELECT proxy_status FROM family_members WHERE id = ?",
                String.class, memberId);
        org.assertj.core.api.Assertions.assertThat(proxyStatus).isEqualTo("NONE");
    }
}
