package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.jayway.jsonpath.JsonPath;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 阶段二：health_articles.video_key → 详情接口下发签名 videoUrl。
 *
 * 覆盖：有/无 video_key、TTL 7200、过期 410、错签 403、缺签 400、列表不下发。
 * 测试数据用 JdbcTemplate 现场插入（**不建 V9004 dev 种子**），每例前重建，互不干扰。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:articleVideo;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "app.upload.dir=target/test-uploads",
        "app.attachment.sign-secret=test-sign-secret-0123456789abcdef",
        "app.resources.dir=../deploy/resources"
})
@AutoConfigureMockMvc
class HealthArticleVideoTest {

    /** 与 SAFE_KEY 匹配的对象键（32 位小写 hex + .mp4）。 */
    private static final String VIDEO_KEY = "dddddddddddddddddddddddddddddddd.mp4";
    private static final String WITH_VIDEO = "art-with-video";
    private static final String NO_VIDEO = "art-no-video";
    private static final Pattern EXPIRES = Pattern.compile("expires=(\\d+)");

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void seed() throws Exception {
        // 真实文件：签名合法时能读到 200；内容不重要（只验 Content-Type 与状态码）
        Path dir = Paths.get("target", "test-uploads", "attachments");
        Files.createDirectories(dir);
        Files.write(dir.resolve(VIDEO_KEY), new byte[] {0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70});

        jdbc.update("DELETE FROM health_articles WHERE id IN (?, ?)", WITH_VIDEO, NO_VIDEO);
        jdbc.update("INSERT INTO health_articles (id, title, summary, cover_key, video_key, category, type, "
                        + "read_min, published_at, status) VALUES (?, ?, ?, NULL, ?, ?, 'video', 2, ?, 'PUBLISHED')",
                WITH_VIDEO, "有视频的文章", "摘要", VIDEO_KEY, "日常防护", java.sql.Timestamp.from(Instant.now()));
        jdbc.update("INSERT INTO health_articles (id, title, summary, cover_key, video_key, category, type, "
                        + "read_min, published_at, status) VALUES (?, ?, ?, NULL, NULL, ?, 'article', 3, ?, 'PUBLISHED')",
                NO_VIDEO, "无视频的文章", "摘要", "日常防护", java.sql.Timestamp.from(Instant.now()));
    }

    @Test
    void 有video_key_详情下发签名videoUrl_且TTL约7200() throws Exception {
        MvcResult r = mockMvc.perform(get("/api/v1/health-articles/" + WITH_VIDEO))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.videoUrl").isNotEmpty())
                .andReturn();
        String body = r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8);
        String videoUrl = JsonPath.read(body, "$.data.videoUrl");

        assertThat(videoUrl).startsWith("/api/v1/attachments/" + VIDEO_KEY + "?expires=");
        Matcher m = EXPIRES.matcher(videoUrl);
        assertThat(m.find()).isTrue();
        long ttl = Long.parseLong(m.group(1)) - Instant.now().getEpochSecond();
        // 默认 app.attachment.video-ttl-seconds=7200；留 100s 容差
        assertThat(ttl).as("视频 TTL 应约 7200 秒，而不是默认 900").isBetween(7100L, 7210L);
    }

    @Test
    void 无video_key_详情省略videoUrl字段() throws Exception {
        mockMvc.perform(get("/api/v1/health-articles/" + NO_VIDEO))
                .andExpect(status().isOk())
                // NON_NULL：字段整体缺席，而不是 videoUrl=null
                .andExpect(jsonPath("$.data.videoUrl").doesNotExist());
    }

    @Test
    void 列表不下发videoUrl() throws Exception {
        mockMvc.perform(get("/api/v1/health-articles").param("category", "日常防护"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data[0].videoUrl").doesNotExist());
    }

    @Test
    void videoUrl正常访问_200且video_mime() throws Exception {
        String videoUrl = fetchVideoUrl(WITH_VIDEO);
        mockMvc.perform(get(videoUrl))
                .andExpect(status().isOk())
                .andExpect(content().contentType("video/mp4"))
                .andExpect(header().string("Accept-Ranges", "bytes"))
                .andExpect(header().string("Cache-Control", org.hamcrest.Matchers.containsString("no-store")));
    }

    @Test
    void videoUrl过期_410() throws Exception {
        mockMvc.perform(get("/api/v1/attachments/" + VIDEO_KEY).param("expires", "1").param("sig", "deadbeef"))
                .andExpect(status().isGone())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_URL_EXPIRED"));
    }

    @Test
    void videoUrl错签_403() throws Exception {
        long future = Instant.now().getEpochSecond() + 3600;
        mockMvc.perform(get("/api/v1/attachments/" + VIDEO_KEY)
                        .param("expires", String.valueOf(future))
                        .param("sig", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("ATTACHMENT_SIGNATURE_INVALID"));
    }

    @Test
    void videoUrl缺签_400() throws Exception {
        mockMvc.perform(get("/api/v1/attachments/" + VIDEO_KEY))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    private String fetchVideoUrl(String articleId) throws Exception {
        MvcResult r = mockMvc.perform(get("/api/v1/health-articles/" + articleId))
                .andExpect(status().isOk()).andReturn();
        return JsonPath.read(r.getResponse().getContentAsString(java.nio.charset.StandardCharsets.UTF_8),
                "$.data.videoUrl");
    }
}
