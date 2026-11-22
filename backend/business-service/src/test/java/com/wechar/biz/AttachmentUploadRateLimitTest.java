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
 * L2 附件上传限流回归测试（2026-11-22）。
 *
 * <p>复现的缺陷：{@code POST /api/v1/attachments} 原先不在 RateLimitInterceptor 的
 * LIMITS 表内，登录用户可无限上传 50MB 视频（磁盘 DoS）。这里把配额压到 2 次/窗口，
 * 断言第 3 次被 429 拦截且返回统一信封 + Retry-After。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:l2ratelimit;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.upload.dir=./run/uploads-l2ratelimit",
        "app.rate-limit.upload-per-window=2",
        "app.rate-limit.window-seconds=60"
})
@AutoConfigureMockMvc
class AttachmentUploadRateLimitTest {

    private static final String USER = "dev-user-1";

    @Autowired
    private MockMvc mockMvc;

    @Test
    void 超过上传配额_返回429与RetryAfter() throws Exception {
        for (int i = 0; i < 2; i++) {
            mockMvc.perform(multipart("/api/v1/attachments")
                            .file(png("upload-" + i + ".png"))
                            .header("X-User-Id", USER)
                            .header("Idempotency-Key", "l2-upload-" + i))
                    .andExpect(status().isOk());
        }
        mockMvc.perform(multipart("/api/v1/attachments")
                        .file(png("upload-3.png"))
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "l2-upload-3"))
                .andExpect(status().isTooManyRequests())
                .andExpect(header().exists("Retry-After"))
                .andExpect(jsonPath("$.code").value("RATE_LIMITED"))
                .andExpect(jsonPath("$.retryable").value(true));
    }

    @Test
    void 未认证主体上传_返回401() throws Exception {
        mockMvc.perform(multipart("/api/v1/attachments")
                        .file(png("anonymous.png"))
                        .header("Idempotency-Key", "l2-anonymous"))
                .andExpect(status().isUnauthorized());
    }

    /** 真实 PNG 文件头（服务端魔数校验拒绝纯随机字节）。 */
    private static MockMultipartFile png(String name) {
        byte[] bytes = new byte[2048];
        for (int i = 0; i < bytes.length; i++) {
            bytes[i] = (byte) (i % 251);
        }
        byte[] magic = {(byte) 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A};
        System.arraycopy(magic, 0, bytes, 0, magic.length);
        return new MockMultipartFile("file", name, "image/png", bytes);
    }
}
