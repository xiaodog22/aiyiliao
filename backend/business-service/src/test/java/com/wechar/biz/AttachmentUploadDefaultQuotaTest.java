package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.multipart;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.mock.web.MockMultipartFile;
import org.springframework.test.web.servlet.MockMvc;

/**
 * L2（2026-11-22 敌意审查细化）：默认配额 20 次/分/认证主体。
 *
 * <p>与 {@link AttachmentUploadRateLimitTest}（压到 2 次验证语义）互补：
 * 本用例不覆盖 app.rate-limit.upload-per-window，验证生产默认值确实是 20，
 * 第 21 次上传被 429 拦截；避免“测试只在小配额下通过、默认配置仍可无限刷”。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:l2defaultquota;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.upload.dir=./run/uploads-l2defaultquota"
})
@AutoConfigureMockMvc
class AttachmentUploadDefaultQuotaTest {

    private static final String USER = "dev-user-default-quota";

    @Autowired
    private MockMvc mockMvc;

    @Test
    void 默认配额20次_第21次返回429() throws Exception {
        for (int i = 0; i < 20; i++) {
            mockMvc.perform(multipart("/api/v1/attachments")
                            .file(png("quota-" + i + ".png"))
                            .header("X-User-Id", USER)
                            .header("Idempotency-Key", "l2-default-" + i))
                    .andExpect(status().isOk());
        }
        mockMvc.perform(multipart("/api/v1/attachments")
                        .file(png("quota-21.png"))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "l2-default-21"))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists("Retry-After"))
                .andExpect(jsonPath("$.code").value("RATE_LIMITED"));
    }

    /** 真实 PNG 文件头（服务端魔数校验拒绝纯随机字节）。 */
    private static MockMultipartFile png(String name) {
        byte[] bytes = new byte[1024];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) (i % 251);
        }
        byte[] magic = {(byte) 0x89, (byte) 0x50, (byte) 0x4E, (byte) 0x47, (byte) 0x0D, (byte) 0x0A, (byte) 0x1A, (byte) 0x0A};
        System.arraycopy(magic, 0, bytes, 0, magic.length);
        return new MockMultipartFile("file", name, "image/png", bytes);
    }
}
