package com.wechar.biz;

import static org.hamcrest.Matchers.matchesPattern;
import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * V9 健康档案附件集成测试（H2 MySQL 兼容模式）：
 * 覆盖上传（暂存/挂档）、列表、匿名签名读取（有效/过期/伪造）、删除、
 * 越权 404、超限 413、格式 415、缺幂等键 400、建档挂载 attachmentKeys。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m9test;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.upload.dir=./run/uploads-m9test"
})
@AutoConfigureMockMvc
class M9AttachmentTest {

    private static final String USER = "dev-user-1";

    @Autowired
    private MockMvc mockMvc;

    /** 从信封中提取 data.id（取最后一个指定前缀主键）。 */
    private static String extractId(String body, String prefix) {
        java.util.regex.Matcher m = java.util.regex.Pattern
                .compile("\"id\":\"(" + prefix + "[^\"]+)\"").matcher(body);
        String found = null;
        while (m.find()) {
            found = m.group(1);
        }
        return found == null ? "" : found;
    }

    /** 从信封中提取指定字段的第一个值。 */
    private static String extractField(String body, String field) {
        return java.util.regex.Pattern
                .compile("\"" + field + "\":\"([^\"]+)\"").matcher(body).results()
                .map(m -> m.group(1)).findFirst().orElseThrow();
    }

    private static String body(MvcResult r) throws Exception {
        return r.getResponse().getContentAsString(StandardCharsets.UTF_8);
    }

    private String createRecord(String key, String title) throws Exception {
        MvcResult r = mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", key)
                        .content("{\"category\":\"EXAM\",\"title\":\"" + title
                                + "\",\"recordedAt\":\"2026-10-15T08:00:00Z\"}"))
                .andExpect(status().isOk())
                .andReturn();
        return extractId(body(r), "hr-");
    }

    private static MockMultipartFile png(String name, int size) {
        byte[] bytes = new byte[size];
        for (int i = 0; i < size; i++) {
            bytes[i] = (byte) (i % 251);
        }
        return new MockMultipartFile("file", name, "image/png", bytes);
    }

    // ---------------------------------------------------------------- 主链路

    @Test
    void 上传_列表_签名读取_删除_全链路() throws Exception {
        String recordId = createRecord("m9-key-main-01", "血常规");

        // 上传（挂到既有档案）
        MvcResult up = mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(png("report.png", 2048))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-upload-main-01"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.objectKey").value(matchesPattern("^[0-9a-f]{32}\\.png$")))
                .andExpect(jsonPath("$.data.url").value(startsWith("/api/v1/attachments/")))
                .andExpect(jsonPath("$.data.id").value(startsWith("hra-")))
                .andExpect(jsonPath("$.data.size").value(2048))
                .andExpect(jsonPath("$.data.sha256").value(matchesPattern("^[0-9a-f]{64}$")))
                .andReturn();
        String upBody = body(up);
        String objectKey = extractField(upBody, "objectKey");
        String attachmentId = extractId(upBody, "hra-");

        // 列表（含短期签名 URL）
        mockMvc.perform(get("/api/v1/health-records/" + recordId + "/attachments")
                        .header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", org.hamcrest.Matchers.hasSize(1)))
                .andExpect(jsonPath("$.data[0].objectKey").value(objectKey))
                .andExpect(jsonPath("$.data[0].url").value(startsWith("/api/v1/attachments/" + objectKey)));

        // 档案详情也带附件
        mockMvc.perform(get("/api/v1/health-records/" + recordId).header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.attachments", org.hamcrest.Matchers.hasSize(1)));

        // 匿名签名读取（从列表响应的 url 拆 expires/sig）
        MvcResult list = mockMvc.perform(get("/api/v1/health-records/" + recordId + "/attachments")
                        .header("X-User-Id", USER))
                .andReturn();
        String url = extractField(body(list), "url");
        String query = url.substring(url.indexOf('?') + 1);
        String expires = null;
        String sig = null;
        for (String kv : query.split("&")) {
            if (kv.startsWith("expires=")) {
                expires = kv.substring(8);
            }
            if (kv.startsWith("sig=")) {
                sig = kv.substring(4);
            }
        }
        mockMvc.perform(get("/api/v1/attachments/" + objectKey)
                        .param("expires", expires).param("sig", sig))
                .andExpect(status().isOk())
                .andExpect(org.springframework.test.web.servlet.result.MockMvcResultMatchers
                        .content().contentType(MediaType.IMAGE_PNG));

        // 过期 → 410
        mockMvc.perform(get("/api/v1/attachments/" + objectKey)
                        .param("expires", String.valueOf(Instant.now().getEpochSecond() - 60))
                        .param("sig", sig))
                .andExpect(status().isGone());

        // 伪造签名 → 403
        mockMvc.perform(get("/api/v1/attachments/" + objectKey)
                        .param("expires", expires)
                        .param("sig", "0".repeat(64)))
                .andExpect(status().isForbidden());

        // 删除 → 列表空
        mockMvc.perform(delete("/api/v1/health-records/" + recordId + "/attachments/" + attachmentId)
                        .header("X-User-Id", USER))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/health-records/" + recordId + "/attachments")
                        .header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data", org.hamcrest.Matchers.hasSize(0)));

        // 删除后再读 → 404
        mockMvc.perform(get("/api/v1/attachments/" + objectKey)
                        .param("expires", expires).param("sig", sig))
                .andExpect(status().isNotFound());
    }

    // ---------------------------------------------------------------- 边界

    @Test
    void 暂存上传_建档挂载attachmentKeys() throws Exception {
        // 暂存上传（两段式第一段）
        MvcResult up = mockMvc.perform(multipart("/api/v1/attachments")
                        .file(png("staged.png", 1024))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-stage-01"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.objectKey").value(matchesPattern("^[0-9a-f]{32}\\.png$")))
                .andReturn();
        String objectKey = extractField(body(up), "objectKey");

        // 建档时挂载
        MvcResult cr = mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-key-stage-01")
                        .content("{\"category\":\"EXAM\",\"title\":\"CT报告\","
                                + "\"recordedAt\":\"2026-10-16T08:00:00Z\","
                                + "\"attachmentKeys\":[\"" + objectKey + "\"]}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.attachments", org.hamcrest.Matchers.hasSize(1)))
                .andExpect(jsonPath("$.data.attachments[0].objectKey").value(objectKey))
                .andReturn();
        String recordId = extractId(body(cr), "hr-");

        // 无效 objectKey → 422
        mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-key-stage-02")
                        .content("{\"category\":\"EXAM\",\"title\":\"坏键\","
                                + "\"recordedAt\":\"2026-10-16T09:00:00Z\","
                                + "\"attachmentKeys\":[\"00000000000000000000000000000000.png\"]}"))
                .andExpect(status().isUnprocessableEntity());

        // 删除档案 → 附件行级联清（列表 404）
        mockMvc.perform(delete("/api/v1/health-records/" + recordId).header("X-User-Id", USER))
                .andExpect(status().isOk());
        mockMvc.perform(get("/api/v1/health-records/" + recordId + "/attachments")
                        .header("X-User-Id", USER))
                .andExpect(status().isNotFound());
    }

    @Test
    void 上传边界_不存在档案404_超限413_格式415_缺键400() throws Exception {
        // 档案不存在 → 404
        mockMvc.perform(multipart("/api/v1/health-records/hr-not-exist/attachments")
                        .file(png("x.png", 16))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-404-01"))
                .andExpect(status().isNotFound());

        // 超 10MB → 413
        String recordId = createRecord("m9-key-limit-01", "大文件");
        mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(png("big.png", 10 * 1024 * 1024 + 1))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-413-01"))
                .andExpect(status().isPayloadTooLarge());

        // 格式不符 → 415
        mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(new MockMultipartFile("file", "evil.exe", "application/octet-stream",
                                new byte[]{1, 2, 3}))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-415-01"))
                .andExpect(status().isUnsupportedMediaType());

        // 缺 Idempotency-Key → 400
        mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(png("y.png", 16))
                        .header("X-User-Id", USER))
                .andExpect(status().isBadRequest());

        // 空文件 → 400
        mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(new MockMultipartFile("file", "empty.png", "image/png", new byte[0]))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-empty-01"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void 越权_他人档案附件操作404() throws Exception {
        // dev-user-2 的档案
        MvcResult r = mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-2")
                        .header("Idempotency-Key", "m9-key-u2-01")
                        .content("{\"category\":\"EXAM\",\"title\":\"他人档案\","
                                + "\"recordedAt\":\"2026-10-15T08:00:00Z\"}"))
                .andExpect(status().isOk())
                .andReturn();
        String recordId = extractId(body(r), "hr-");

        // dev-user-1 越权上传/列表/删除 → 一律 404（不泄露存在性）
        mockMvc.perform(multipart("/api/v1/health-records/" + recordId + "/attachments")
                        .file(png("z.png", 16))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "m9-cross-01"))
                .andExpect(status().isNotFound());
        mockMvc.perform(get("/api/v1/health-records/" + recordId + "/attachments")
                        .header("X-User-Id", USER))
                .andExpect(status().isNotFound());
        mockMvc.perform(delete("/api/v1/health-records/" + recordId + "/attachments/hra-x")
                        .header("X-User-Id", USER))
                .andExpect(status().isNotFound());
    }
}
