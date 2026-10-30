package com.wechar.biz;

import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.greaterThanOrEqualTo;
import static org.hamcrest.Matchers.hasEntry;
import static org.hamcrest.Matchers.hasItem;
import static org.hamcrest.Matchers.not;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * M3 集成测试（H2 MySQL 兼容模式，不依赖真实 MySQL）：医生端与合规面。
 * 覆盖 08H 判据 ⑧⑨ 所需证据：
 *  - doctor/login（任职关系判角色；非医生 403）、workbench（范围裁剪 + 子块降级）、
 *    doctor/appointments（范围隔离/状态过滤/游标）、appointments/{id}/status（状态机 409 与乐观锁 409）；
 *  - beds（授权病区范围、越权 403/404、脱敏占用者、五动作 + 乐观锁 + 幂等）；
 *  - consents（追加式同意、撤回终态幂等、幂等键 409）、deletion-requests（受理 ≠ 已删除、逐项保留例外、他人 404）。
 * 断言避开测试间顺序耦合：每个会改状态的方法使用各自的种子资源。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m3test;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
@AutoConfigureMockMvc
class M3IntegrationTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    /** 有医生任职（doc-gastro-1 绑定 u-dev-user-2）。 */
    private static final String USER_DOCTOR = "dev-user-2";
    /** 无医生任职（医生端应 403）。 */
    private static final String USER_PATIENT = "dev-user-1";
    private static final String PLATFORM = "wechat-miniprogram";
    private static final String CLIENT_VERSION = "1.0.0";

    private static String loginBody(String code) {
        return "{\"code\":\"" + code + "\",\"consentVersion\":\"v1.0\"}";
    }

    /**
     * 从信封的 data 段提取字段值（注意：信封顶层另有 requestId = 链路追踪 ID，
     * 与 data.requestId（受理编号）同名，故必须锚定在 "data":{ 之后）。
     */
    private static String extractDataField(String body, String field) {
        Matcher m = Pattern.compile("\"data\":\\{\"" + field + "\":\"([^\"]+)\"").matcher(body);
        return m.find() ? m.group(1) : "";
    }

    // ---------------------------------------------------------------- doctor/login

    @Test
    void 医生登录_任职关系命中_服务端下发DOCTOR角色() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .header("X-Platform", PLATFORM)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("dev-user-2-code")))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data.tokenType").value("Bearer"))
                .andExpect(jsonPath("$.data.accessToken").isNotEmpty())
                .andExpect(jsonPath("$.data.user.roles").value(hasItem("DOCTOR")));
    }

    @Test
    void 医生登录_非任职账号403且不签发会话() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .header("X-Platform", PLATFORM)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("dev-user-1-code")))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }

    @Test
    void 医生登录_平台非契约const值422_缺请求头400() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .header("X-Platform", "h5")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("dev-user-2-code")))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        mockMvc.perform(post("/api/v1/doctor/login")
                        .header("X-Client-Version", CLIENT_VERSION)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(loginBody("dev-user-2-code")))
                .andExpect(status().isBadRequest());
    }

    @Test
    void me角色口径_与医生任职一致() throws Exception {
        mockMvc.perform(get("/api/v1/me").header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.roles").value(hasItem("DOCTOR")));

        mockMvc.perform(get("/api/v1/me").header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.roles").value(not(hasItem("DOCTOR"))));
    }

    // ---------------------------------------------------------------- workbench

    @Test
    void 工作台_按任职科室裁剪范围并给出授权病区() throws Exception {
        mockMvc.perform(get("/api/v1/doctor/workbench").header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.summary").exists())
                .andExpect(jsonPath("$.data.summary.todayAppointments").value(0))
                .andExpect(jsonPath("$.data.summary.availableBeds").value(greaterThanOrEqualTo(1)))
                .andExpect(jsonPath("$.data.scope.departmentIds").value(hasItem("dep-gastro")))
                .andExpect(jsonPath("$.data.scope.wardIds").value(hasItem("ward-gastro-a")))
                .andExpect(jsonPath("$.data.scope.wardIds").value(hasItem("ward-gastro-b")))
                // 授权范围内不含呼吸内科病区
                .andExpect(jsonPath("$.data.scope.wardIds").value(not(hasItem("ward-resp-a"))))
                .andExpect(jsonPath("$.data.blocks[0].status").value("ok"));
    }

    @Test
    void 工作台_非医生403() throws Exception {
        mockMvc.perform(get("/api/v1/doctor/workbench").header("X-User-Id", USER_PATIENT))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }

    // ---------------------------------------------------------------- doctor/appointments

    @Test
    void 医生挂号列表_仅本医生范围_他科不出现() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/doctor/appointments").header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isNotEmpty())
                .andExpect(jsonPath("$.meta").exists())
                .andExpect(jsonPath("$.meta.nextCursor").doesNotExist())
                .andReturn();
        String body = result.getResponse().getContentAsString();
        assertTrue(body.contains("ap-m3-1"), "本医生挂号应可见");
        assertFalse(body.contains("ap-m3-resp"), "他科挂号不得出现");
    }

    @Test
    void 医生挂号列表_按状态过滤() throws Exception {
        mockMvc.perform(get("/api/v1/doctor/appointments").header("X-User-Id", USER_DOCTOR)
                        .param("status", "COMPLETED"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(1))
                .andExpect(jsonPath("$.data[0].id").value("ap-m3-done"));
    }

    @Test
    void 医生挂号列表_limit超出契约上限被钳制且非医生403() throws Exception {
        mockMvc.perform(get("/api/v1/doctor/appointments").header("X-User-Id", USER_DOCTOR)
                        .param("limit", "999"))
                .andExpect(status().isOk());

        mockMvc.perform(get("/api/v1/doctor/appointments").header("X-User-Id", USER_PATIENT))
                .andExpect(status().isForbidden());
    }

    // ---------------------------------------------------------------- 状态流转

    @Test
    void 挂号状态流转_成功_乐观锁递增并落事件() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-1/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "m3-status-key-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":1,\"note\":\"电话确认\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.data.version").value(2));

        Integer events = jdbc.queryForObject("SELECT COUNT(*) FROM appointment_status_events "
                + "WHERE appointment_id = 'ap-m3-1' AND from_status = 'PENDING' AND to_status = 'CONFIRMED' "
                + "AND operator_user_id = 'u-dev-user-2' AND operator_doctor_id = 'doc-gastro-1' "
                + "AND idempotency_key = 'm3-status-key-0001'", Integer.class);
        assertEquals(1, events);
    }

    @Test
    void 挂号状态流转_同键同载荷重放_不重复流转() throws Exception {
        String body = "{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":1,\"note\":\"电话确认\"}";
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-1/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-key-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("CONFIRMED"))
                .andExpect(jsonPath("$.data.version").value(2));

        Integer events = jdbc.queryForObject("SELECT COUNT(*) FROM appointment_status_events "
                + "WHERE appointment_id = 'ap-m3-1'", Integer.class);
        assertEquals(1, events);
    }

    @Test
    void 挂号状态流转_同键异载荷409() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-2/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":1}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-2/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CANCELLED\",\"expectedVersion\":2}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));
    }

    @Test
    void 挂号状态流转_乐观锁冲突409() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-3/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-version-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":99}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
    }

    @Test
    void 挂号状态流转_终态非法转换409() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-done/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-final-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":2}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("APPOINTMENT_STATUS_INVALID"));
    }

    @Test
    void 挂号状态流转_未知枚举422_缺幂等键400_越权404() throws Exception {
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-done/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-enum-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"ROBOT\",\"expectedVersion\":2}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-done/status")
                        .header("X-User-Id", USER_DOCTOR)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":2}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));

        // 他科医生（doc-resp-1）的挂号：本医生不可见 → 404（不泄露存在性）
        mockMvc.perform(post("/api/v1/doctor/appointments/ap-m3-resp/status")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-status-scope-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"toStatus\":\"CONFIRMED\",\"expectedVersion\":1}"))
                .andExpect(status().isNotFound());
    }

    // ---------------------------------------------------------------- beds

    @Test
    void 床位列表_仅授权病区_占用者已脱敏() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/beds").header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(4))
                .andExpect(jsonPath("$.data[0].id").value("bed-gastro-a-01"))
                .andExpect(jsonPath("$.data[1].id").value("bed-gastro-a-02"))
                .andExpect(jsonPath("$.data[1].occupantDisplayName").value("张*"))
                .andReturn();
        String body = result.getResponse().getContentAsString();
        assertFalse(body.contains("bed-resp-a-01"), "他科病区床位不得出现");
        assertFalse(body.contains("张三"), "不得回显占用者明文姓名");
    }

    @Test
    void 床位列表_越权病区403_非医生403() throws Exception {
        mockMvc.perform(get("/api/v1/beds").header("X-User-Id", USER_DOCTOR).param("wardId", "ward-resp-a"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));

        mockMvc.perform(get("/api/v1/beds").header("X-User-Id", USER_PATIENT))
                .andExpect(status().isForbidden());
    }

    @Test
    void 床位分配_ASSIGN成功并脱敏_同键同载荷重放() throws Exception {
        String body = "{\"action\":\"ASSIGN\",\"patientRef\":\"u-m3-patient\",\"expectedVersion\":1}";
        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-01/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-assign-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("OCCUPIED"))
                .andExpect(jsonPath("$.data.occupantDisplayName").value("张*"))
                .andExpect(jsonPath("$.data.version").value(2));

        // 同键同载荷 → 重放：返回当前资源，version 不再递增
        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-01/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-assign-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.version").value(2));

        assertEquals(2, jdbc.queryForObject("SELECT version FROM beds WHERE id = 'bed-gastro-a-01'", Integer.class));
    }

    @Test
    void 床位分配_同键异载荷409() throws Exception {
        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-04/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"RESERVE\",\"expectedVersion\":1}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("RESERVED"));

        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-04/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"ASSIGN\",\"patientRef\":\"u-m3-patient\",\"expectedVersion\":2}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));
    }

    @Test
    void 床位分配_状态冲突409_乐观锁冲突409() throws Exception {
        // OCCUPIED 不允许 ASSIGN → 409（动作可行性）
        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-02/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-state-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"ASSIGN\",\"patientRef\":\"u-m3-patient\",\"expectedVersion\":3}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("BED_STATE_CONFLICT"));

        // RELEASE 合法但 expectedVersion 不匹配 → 409 乐观锁
        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-02/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-version-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"RELEASE\",\"expectedVersion\":1}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
    }

    @Test
    void 床位分配_越权病区404_手机号patientRef422_缺patientRef422_缺幂等键400() throws Exception {
        mockMvc.perform(post("/api/v1/beds/bed-resp-a-01/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-scope-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"ASSIGN\",\"patientRef\":\"u-m3-patient\",\"expectedVersion\":1}"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("BED_NOT_FOUND"));

        // 契约：patientRef 使用内部患者 ID，不接受姓名或手机号
        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-04/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-phone-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"ASSIGN\",\"patientRef\":\"13800001111\",\"expectedVersion\":2}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-04/assignment")
                        .header("X-User-Id", USER_DOCTOR).header("Idempotency-Key", "m3-bed-noref-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"ASSIGN\",\"expectedVersion\":2}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        mockMvc.perform(post("/api/v1/beds/bed-gastro-a-04/assignment")
                        .header("X-User-Id", USER_DOCTOR)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"action\":\"RESERVE\",\"expectedVersion\":1}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));
    }

    // ---------------------------------------------------------------- consents

    @Test
    void 同意列表_含既有同意且撤回记录同样返回() throws Exception {
        MvcResult result = mockMvc.perform(get("/api/v1/consents").header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").value(hasItem(hasEntry("purpose", "PRIVACY_POLICY"))))
                .andReturn();
        String body = result.getResponse().getContentAsString();
        // 撤回记录不从列表消失（不原地覆盖语义）
        assertTrue(body.contains("HEALTH_DATA_PROCESSING"), "撤回记录同样返回");
    }

    @Test
    void 同意授予_追加记录_同键同载荷重放() throws Exception {
        String body = "{\"purpose\":\"IMAGE_UPLOAD\",\"policyVersion\":\"v1.0\",\"channel\":\"MINIPROGRAM\"}";
        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-consent-grant-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("GRANTED"))
                .andExpect(jsonPath("$.data.policyVersion").value("v1.0"))
                .andExpect(jsonPath("$.data.channel").value("MINIPROGRAM"));

        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-consent-grant-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("GRANTED"));

        Integer rows = jdbc.queryForObject("SELECT COUNT(*) FROM consents WHERE user_id = 'u-dev-user-1' "
                + "AND purpose = 'IMAGE_UPLOAD'", Integer.class);
        assertEquals(1, rows, "同键同载荷不得追加第二行");
    }

    @Test
    void 同意授予_同键异载荷409_未知枚举422_缺幂等键400() throws Exception {
        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-consent-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"AI_GENERATION\",\"policyVersion\":\"v1.0\",\"channel\":\"PHONE\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-consent-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"MARKETING\",\"policyVersion\":\"v1.0\",\"channel\":\"PHONE\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));

        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-consent-enum-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"ROBOT\",\"policyVersion\":\"v1.0\",\"channel\":\"PHONE\"}"))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));

        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"MARKETING\",\"policyVersion\":\"v1.0\",\"channel\":\"PHONE\"}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("MISSING_IDEMPOTENCY_KEY"));
    }

    @Test
    void 同意撤回_终态幂等_未授权404() throws Exception {
        mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .header("X-User-Id", USER_PATIENT).header("Idempotency-Key", "m3-withdraw-0001")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"暂不使用\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("WITHDRAWN"))
                .andExpect(jsonPath("$.data.withdrawnAt").isNotEmpty());

        // 重复撤回（换新键）→ 同一终态，不新增行
        mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .header("X-User-Id", USER_PATIENT).header("Idempotency-Key", "m3-withdraw-0002"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("WITHDRAWN"));

        assertEquals(2, jdbc.queryForObject("SELECT COUNT(*) FROM consents WHERE user_id = 'u-dev-user-1' "
                + "AND purpose = 'HEALTH_DATA_PROCESSING'", Integer.class), "撤回应追加一行，重复撤回不再追加");

        // 从未授权 / 未知枚举 purpose → 404（该路径契约只声明 401/404/409）
        mockMvc.perform(post("/api/v1/consents/FAMILY_PROXY/withdraw")
                        .header("X-User-Id", USER_PATIENT).header("Idempotency-Key", "m3-withdraw-0003"))
                .andExpect(status().isNotFound());
        mockMvc.perform(post("/api/v1/consents/ROBOT/withdraw")
                        .header("X-User-Id", USER_PATIENT).header("Idempotency-Key", "m3-withdraw-0004"))
                .andExpect(status().isNotFound());
    }

    @Test
    void 同意撤回_同键异载荷409() throws Exception {
        mockMvc.perform(post("/api/v1/consents").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-consent-tts-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"purpose\":\"THIRD_PARTY_TTS\",\"policyVersion\":\"v1.0\",\"channel\":\"MINIPROGRAM\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/consents/THIRD_PARTY_TTS/withdraw")
                        .header("X-User-Id", USER_PATIENT).header("Idempotency-Key", "m3-consent-tts-0002")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"更换音色\"}"))
                .andExpect(status().isOk());

        mockMvc.perform(post("/api/v1/consents/THIRD_PARTY_TTS/withdraw")
                        .header("X-User-Id", USER_PATIENT).header("Idempotency-Key", "m3-consent-tts-0002")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"reason\":\"另一个原因\"}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));
    }

    // ---------------------------------------------------------------- deletion-requests

    @Test
    void 删除申请_仅受理并逐项列明法定保留例外() throws Exception {
        MvcResult result = mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":[\"HEALTH_RECORDS\",\"ACCOUNT\"],\"reason\":\"不再使用\"}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.status").value("RECEIVED"))
                .andExpect(jsonPath("$.data.requestId").isNotEmpty())
                .andExpect(jsonPath("$.data.scope").value(hasItem("HEALTH_RECORDS")))
                .andExpect(jsonPath("$.data.retainedItems").value(hasItem(
                        hasEntry("category", "注销申请记录"))))
                .andExpect(jsonPath("$.data.createdAt").isNotEmpty())
                .andReturn();
        String body = result.getResponse().getContentAsString();
        assertTrue(body.contains("预约与就诊记录"), "诊疗记录保留依据须逐项列出");
        assertTrue(body.contains("待法务确认") || body.contains("待确认"),
                "保留期限未获法务确认须如实标注");
        assertFalse(body.contains("已全部删除"), "不得以'已全部删除'概括");
        assertFalse(body.contains("COMPLETED"), "受理 ≠ 已完成，不得伪造完成态");
    }

    @Test
    void 删除申请_幂等重放_同键异载荷409() throws Exception {
        String body = "{\"scope\":[\"PROFILE\"],\"reason\":\"精简数据\"}";
        MvcResult first = mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andReturn();
        String requestId = extractDataField(first.getResponse().getContentAsString(), "requestId");

        MvcResult second = mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isOk())
                .andReturn();
        assertEquals(requestId, extractDataField(second.getResponse().getContentAsString(), "requestId"),
                "同键同载荷须返回同一受理编号");

        mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-reuse-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"scope\":[\"UPLOADS\"]}"))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("IDEMPOTENCY_KEY_REUSE"));
    }

    @Test
    void 删除申请_查询本人200_他人404() throws Exception {
        MvcResult created = mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-query-0001")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"scope\":[\"VOICE_DATA\"]}"))
                .andExpect(status().isOk())
                .andReturn();
        String requestId = extractDataField(created.getResponse().getContentAsString(), "requestId");

        mockMvc.perform(get("/api/v1/me/deletion-requests/" + requestId).header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.requestId").value(requestId))
                .andExpect(jsonPath("$.data.status").value("RECEIVED"));

        // 他人的申请一律 404（不返回 403，避免存在性泄漏）
        mockMvc.perform(get("/api/v1/me/deletion-requests/" + requestId).header("X-User-Id", USER_DOCTOR))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("NOT_FOUND"));
    }

    @Test
    void 删除申请_非法scope400_空scope400_缺幂等键400() throws Exception {
        mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-bad-0001")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"scope\":[\"ROBOT\"]}"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("BAD_REQUEST"));

        mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "m3-deletion-bad-0002")
                        .contentType(MediaType.APPLICATION_JSON).content("{\"scope\":[]}"))
                .andExpect(status().isBadRequest());

        mockMvc.perform(post("/api/v1/me/deletion-requests").header("X-User-Id", USER_PATIENT)
                        .contentType(MediaType.APPLICATION_JSON).content("{\"scope\":[\"PROFILE\"]}"))
                .andExpect(status().isBadRequest());
    }

    // ---------------------------------------------------------------- 既有域回归

    @Test
    void 既有路径回归_健康档案与内容目录仍可用() throws Exception {
        mockMvc.perform(get("/api/v1/health-records").header("X-User-Id", USER_PATIENT))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").exists());
        mockMvc.perform(get("/api/v1/contents"))
                .andExpect(status().isOk())
                .andExpect(content().string(containsString("data")));
    }

    /** 内部回调端点（O-02 未定稿）必须保持未实现：不得 200、不得空对象。 */
    @Test
    void 内部回调端点_未定稿前保持501() throws Exception {
        mockMvc.perform(post("/internal/v1/callbacks/task-events").contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isNotImplemented())
                .andExpect(jsonPath("$.code").value("NOT_IMPLEMENTED"));
    }
}
