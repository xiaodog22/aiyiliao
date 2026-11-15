package com.wechar.biz;

import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 线上问诊图片消息合规（2026-11-15）：
 * 患者只能发送**本人健康档案**里的 jpeg/png/webp 附件；
 * 直接调接口塞任意外部 objectKey 必须 422，合法附件落库为 IMAGE_NOTE 并回传附件展示字段。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:cnguard;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql",
        "app.upload.dir=./run/uploads-cnguard"
})
@AutoConfigureMockMvc
class ConsultationAttachmentGuardTest {

    private static final String USER_PATIENT = "dev-user-1";
    private static final String USER_DOCTOR = "dev-user-2";
    /** test-m3-seed 中 doc-gastro-1 绑定 dev-user-2（创建会话时必须传医生主键，不是用户 id） */
    private static final String DOCTOR_ID = "doc-gastro-1";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    private static String body(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private static MockMultipartFile png(String name, int size) {
        byte[] bytes = new byte[size];
        for (int i = 0; i < size; i++) {
            bytes[i] = (byte) (i % 251);
        }
        byte[] magic = {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(magic, 0, bytes, 0, magic.length);
        return new MockMultipartFile("file", name, "image/png", bytes);
    }

    /** 建档案 → 上传一张合法 PNG，返回 objectKey。 */
    private String uploadHealthImage() throws Exception {
        MvcResult rec = mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "cnguard-rec-" + UUID.randomUUID())
                        .content("{\"category\":\"EXAM\",\"title\":\"血常规\","
                                + "\"recordedAt\":\"2026-10-15T08:00:00Z\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String recordId = java.util.regex.Pattern.compile("\"id\":\"(hr-[^\"]+)\"")
                .matcher(body(rec)).results().map(m -> m.group(1)).findFirst().orElseThrow();

        MvcResult up = mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(png("report.png", 2048))
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "cnguard-up-" + UUID.randomUUID()))
                .andExpect(status().isOk())
                .andReturn();
        return java.util.regex.Pattern.compile("\"objectKey\":\"([^\"]+)\"")
                .matcher(body(up)).results().map(m -> m.group(1)).findFirst().orElseThrow();
    }

    /** 患者指定医生建会话（未接单）。 */
    private String createConsultation() throws Exception {
        MvcResult created = mockMvc.perform(post("/api/v1/consultations")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "cnguard-create-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"initialMessage\":\"皮疹三天，想请医生看看报告。\",\"doctorId\":\""
                                + DOCTOR_ID + "\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return java.util.regex.Pattern.compile("\"consultation\":\\{\"id\":\"(cn-[^\"]+)\"")
                .matcher(body(created)).results().map(m -> m.group(1)).findFirst().orElseThrow();
    }

    /** 患者指定医生建会话 → 医生接单。 */
    private String createAcceptedConsultation() throws Exception {
        String cid = createConsultation();
        mockMvc.perform(post("/api/v1/doctor/consultations/" + cid + "/accept")
                        .header("X-User-Id", USER_DOCTOR)
                        .header("Idempotency-Key", "cnguard-accept-" + UUID.randomUUID()))
                .andExpect(status().isOk());
        return cid;
    }

    /**
     * 登记一条 health.* 资源（H2 测试档 Flyway 停在 V26，V30 的系统推送报告不在库里，
     * 这里按 V30 同形补一条，验证资源库白名单与 URL 下发）。
     */
    private String registerHealthResource() {
        String key = "health.test-" + UUID.randomUUID();
        jdbc.update("INSERT INTO resource_asset "
                        + "(resource_key, category, file_path, mime_type, file_size, status, level, sort_order) "
                        + "VALUES (?,?,?,?,?,?,?,?)",
                key, "image", "health/test.jpg", "image/jpeg", 21304L, 1, "B", 90);
        return key;
    }

    private org.springframework.test.web.servlet.ResultActions sendImage(String cid, String content)
            throws Exception {
        return mockMvc.perform(post("/api/v1/consultations/" + cid + "/messages")
                .header("X-User-Id", USER_PATIENT)
                .header("Idempotency-Key", "cnguard-msg-" + UUID.randomUUID())
                .contentType(MediaType.APPLICATION_JSON)
                .content("{\"content\":\"" + content + "\",\"inputMode\":\"IMAGE\"}"));
    }

    @Test
    void 任意外部_objectKey_一律_422() throws Exception {
        String cid = createAcceptedConsultation();
        String forged = "0123456789abcdef0123456789abcdef.png";
        sendImage(cid, forged)
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_NOT_ALLOWED"));
    }

    @Test
    void 健康档案图片_落库为_IMAGE_NOTE_并下发附件_URL() throws Exception {
        String key = uploadHealthImage();
        String cid = createAcceptedConsultation();
        sendImage(cid, key)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.message.contentType").value("IMAGE_NOTE"))
                .andExpect(jsonPath("$.data.message.attachmentUrl").value(startsWith("/api/v1/attachments/")));
    }

    @Test
    void 系统推送报告health资源_可发送并下发资源_URL() throws Exception {
        String key = registerHealthResource();
        String cid = createAcceptedConsultation();
        sendImage(cid, key)
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.message.contentType").value("IMAGE_NOTE"))
                .andExpect(jsonPath("$.data.message.attachmentUrl").value(startsWith("/api/v1/resources/")))
                .andExpect(jsonPath("$.data.message.attachmentName").value("健康档案报告.jpg"));
    }

    @Test
    void 非health资源_不得作为检查资料发送() throws Exception {
        String cid = createAcceptedConsultation();
        // home.* 是登录页主视觉，资源存在但不是健康档案报告 → 必须 422
        sendImage(cid, "home.ai-doctor")
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_NOT_ALLOWED"));
    }

    @Test
    void 医生接单前_患者可继续补充消息() throws Exception {
        String cid = createConsultation();
        mockMvc.perform(post("/api/v1/consultations/" + cid + "/messages")
                        .header("X-User-Id", USER_PATIENT)
                        .header("Idempotency-Key", "cnguard-more-" + UUID.randomUUID())
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"content\":\"补充：昨晚开始发热，最高 38.5 度。\",\"inputMode\":\"TEXT\"}"))
                .andExpect(status().isOk());
    }
}
