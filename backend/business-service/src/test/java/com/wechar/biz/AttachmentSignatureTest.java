package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wechar.biz.patient.AttachmentStorage;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 附件签名 URL 判定矩阵（V14 遗留缺陷修复）。
 *
 * 修复前：`@RequestParam long expires / String sig` 为必填，缺参抛
 * `MissingServletRequestParameterException` → 被兜底成 **500**。
 * 修复后判定顺序固定：缺参 400 → 过期 410 → 错签 403 → 不存在 404 → 200。
 *
 * ⚠️ 第 4 例是本次重点：用「**未来** expires + 错误 sig」，证明 sig 真正参与 HMAC 校验，
 * 而不是只靠 expires 过期来挡（只测 `expires=1` 会把"签名完全没校验"的漏洞漏过去）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:attachsig;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "app.upload.dir=target/test-uploads",
        "app.attachment.sign-secret=test-sign-secret-0123456789abcdef",
        "app.resources.dir=../deploy/resources"
})
@AutoConfigureMockMvc
class AttachmentSignatureTest {

    /** 1×1 PNG 头 + 少量字节：足够验证"返回的是文件字节而非 JSON"。 */
    private static final byte[] PNG_BYTES = {
            (byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
            0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52
    };

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private AttachmentStorage attachmentStorage;

    private String objectKey;

    @BeforeEach
    void uploadOnce() {
        objectKey = attachmentStorage.save(
                new MockMultipartFile("file", "report.png", "image/png", PNG_BYTES));
    }

    @Test
    void 缺sig_返回400而不是500() throws Exception {
        long future = Instant.now().getEpochSecond() + 600;
        mockMvc.perform(get("/api/v1/attachments/" + objectKey).param("expires", String.valueOf(future)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    @Test
    void 缺expires_返回400而不是500() throws Exception {
        mockMvc.perform(get("/api/v1/attachments/" + objectKey).param("sig", "deadbeef"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    @Test
    void 两个参数都缺_返回400() throws Exception {
        mockMvc.perform(get("/api/v1/attachments/" + objectKey))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    @Test
    void 过期_返回410() throws Exception {
        mockMvc.perform(get("/api/v1/attachments/" + objectKey)
                        .param("expires", "1")
                        .param("sig", "deadbeef"))
                .andExpect(status().isGone())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_URL_EXPIRED"));
    }

    @Test
    void 未来expires加上错误sig_返回403_证明sig真正参与校验() throws Exception {
        long future = Instant.now().getEpochSecond() + 3600;
        // 32 位 hex 形状的"签名"，与 HMAC 结果必然不同
        String wrongSig = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        mockMvc.perform(get("/api/v1/attachments/" + objectKey)
                        .param("expires", String.valueOf(future))
                        .param("sig", wrongSig))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_SIGNATURE_INVALID"));
    }

    @Test
    void 正确签名_返回200_图片字节与no_store() throws Exception {
        String signed = attachmentStorage.signedUrl(objectKey);
        assertThat(signed).startsWith("/api/v1/attachments/" + objectKey + "?expires=");

        MvcResult result = mockMvc.perform(get(signed))
                .andExpect(status().isOk())
                .andExpect(content().contentType("image/png"))
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")))
                .andExpect(header().string("Content-Length", String.valueOf(PNG_BYTES.length)))
                .andReturn();

        assertThat(result.getResponse().getContentAsByteArray()).hasSize(PNG_BYTES.length);
        assertThat(result.getResponse().getContentAsByteArray()[0]).isEqualTo((byte) 0x89);
    }

    @Test
    void 签名合法但文件不存在_返回404() throws Exception {
        // 该 key 形状合法（32 hex + .png），签名也合法，但磁盘上没有 → 404（不泄露存在性）
        String missingKey = "00000000000000000000000000000000.png";
        String signed = attachmentStorage.signedUrl(missingKey);
        mockMvc.perform(get(signed))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_NOT_FOUND"));
    }

    @Test
    void objectKey形状非法_验签阶段即拒绝403() throws Exception {
        // 非 32hex 形状（abc.png）：SAFE_KEY 不匹配 → 验签直接 false → 403。
        // 这里**刻意不给 404**：区分"格式非法(403)"与"格式合法但文件不存在(404)"会让攻击者
        // 能试探 key 格式；统一在验签阶段拒掉，且不触碰文件系统。
        String badKey = "abc.png";
        String signed = attachmentStorage.signedUrl(badKey);
        mockMvc.perform(get(signed))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_SIGNATURE_INVALID"));
    }
}
