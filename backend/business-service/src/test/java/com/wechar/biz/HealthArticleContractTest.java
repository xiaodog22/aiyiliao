package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * N12/N13 健康科普契约测试（2026-10-19，仿 M4ContractCoreTest 探针范式）：
 *  - N12：200 列表（分类/搜索过滤 + 游标分页 nextCursor）· 400 type 非法；
 *  - N13：200 详情（sections/tip/related + coverUrl 签名 URL）· 404 不存在；
 * 数据由测试自行 INSERT（V13 health_articles），不依赖 dev 种子（生产空表=前端降级，红线）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m1213;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8"
})
@AutoConfigureMockMvc
class HealthArticleContractTest {

    @Autowired
    private MockMvc mockMvc;
    @Autowired
    private JdbcTemplate jdbc;

    private final ObjectMapper mapper = new ObjectMapper();

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

    @BeforeEach
    void seedArticles() {
        // 幂等种子（同 id 直接覆盖思路不可用 → 先清后插，测试上下文内无并发）
        jdbc.update("DELETE FROM health_articles");
        jdbc.update("INSERT INTO health_articles (id, title, summary, cover_key, category, type, read_min, "
                        + "published_at, sections_json, tip, related_json, status) VALUES "
                        + "('art-sleep-1', '睡前一小时放下手机', '助眠习惯科普', 'cover/sleep1.png', 'sleep', 'article', 5, "
                        + " TIMESTAMP '2026-10-10 08:00:00', "
                        + "'[{\"title\":\"为何影响睡眠\",\"body\":\"蓝光抑制褪黑素分泌。\"}]', "
                        + "'睡前调暗灯光。', '[\"art-digest-1\"]', 'PUBLISHED')");
        jdbc.update("INSERT INTO health_articles (id, title, summary, cover_key, category, type, read_min, "
                        + "published_at, sections_json, tip, related_json, status) VALUES "
                        + "('art-digest-1', '饭后百步走的正确姿势', '消化科科普', NULL, 'digest', 'video', 3, "
                        + " TIMESTAMP '2026-10-12 09:00:00', NULL, NULL, NULL, 'PUBLISHED')");
        jdbc.update("INSERT INTO health_articles (id, title, summary, category, type, published_at, status) VALUES "
                        + "('art-hidden-1', '未发布草稿', NULL, 'sleep', 'article', TIMESTAMP '2026-10-13 09:00:00', 'DRAFT')");
    }

    @Test
    void 科普列表与详情域() throws Exception {
        // N12 列表：200；数据按 published_at DESC，未上架不出现
        MvcResult list = mockMvc.perform(get("/api/v1/health-articles")).andReturn();
        probe("GET /api/v1/health-articles", st(list), 200, 400, 503);
        var arr = mapper.readTree(body(list)).get("data");
        if (arr.size() != 2) {
            throw new AssertionError("应返回 2 篇上架文章（草稿不出现），实际 " + arr.size() + ": " + arr);
        }
        if (!"art-digest-1".equals(arr.get(0).get("id").asText())) {
            throw new AssertionError("排序应为 published_at DESC: " + arr);
        }
        if (arr.get(0).has("sections")) {
            throw new AssertionError("列表响应不应携带 sections（仅详情下发）: " + arr.get(0));
        }

        // N12 分类过滤
        MvcResult filtered = mockMvc.perform(get("/api/v1/health-articles").param("category", "sleep")).andReturn();
        probe("GET /api/v1/health-articles?category", st(filtered), 200, 400, 503);
        var sleepArr = mapper.readTree(body(filtered)).get("data");
        if (sleepArr.size() != 1 || !"art-sleep-1".equals(sleepArr.get(0).get("id").asText())) {
            throw new AssertionError("category=sleep 过滤失败: " + sleepArr);
        }

        // N12 关键词搜索
        MvcResult kw = mockMvc.perform(get("/api/v1/health-articles").param("kw", "百步走")).andReturn();
        probe("GET /api/v1/health-articles?kw", st(kw), 200, 400, 503);
        if (mapper.readTree(body(kw)).get("data").size() != 1) {
            throw new AssertionError("kw 搜索失败: " + body(kw));
        }

        // N12 type 非法 → 400（契约仅声明 400/503，未声明 422）
        probe("GET /api/v1/health-articles?type非法",
                st(mockMvc.perform(get("/api/v1/health-articles").param("type", "podcast")).andReturn()), 400);

        // N12 游标分页：limit=1 → nextCursor 非空 → 第二页无重复无遗漏
        MvcResult p1 = mockMvc.perform(get("/api/v1/health-articles").param("limit", "1")).andReturn();
        var p1Json = mapper.readTree(body(p1));
        String cursor = p1Json.get("meta").get("nextCursor").asText(null);
        if (cursor == null || cursor.isBlank()) {
            throw new AssertionError("limit=1 应给出 nextCursor: " + body(p1));
        }
        MvcResult p2 = mockMvc.perform(get("/api/v1/health-articles")
                .param("limit", "1").param("cursor", cursor)).andReturn();
        var p2Arr = mapper.readTree(body(p2)).get("data");
        if (p2Arr.size() != 1 || "art-digest-1".equals(p2Arr.get(0).get("id").asText())) {
            throw new AssertionError("第二页应为另一页且无重复: " + p2Arr);
        }

        // N13 详情：200，sections/tip/related 齐全，coverUrl 为签名 URL（expires+sig）
        MvcResult detail = mockMvc.perform(get("/api/v1/health-articles/art-sleep-1")).andReturn();
        probe("GET /api/v1/health-articles/{articleId}", st(detail), 200, 404, 503);
        var d = mapper.readTree(body(detail)).get("data");
        if (!d.has("sections") || d.get("sections").size() != 1 || d.get("tip") == null
                || d.get("related").size() != 1) {
            throw new AssertionError("详情缺 sections/tip/related: " + d);
        }
        String coverUrl = d.get("coverUrl").asText("");
        if (!coverUrl.contains("expires=") || !coverUrl.contains("sig=")) {
            throw new AssertionError("coverUrl 应为 Attachment 签名 URL: " + coverUrl);
        }
        // 无封面文章 → coverUrl 省略（NON_NULL）
        MvcResult noCover = mockMvc.perform(get("/api/v1/health-articles/art-digest-1")).andReturn();
        if (mapper.readTree(body(noCover)).get("data").has("coverUrl")) {
            throw new AssertionError("无封面时 coverUrl 应省略: " + body(noCover));
        }

        // N13 不存在 → 404；草稿（未上架）→ 同 404（不泄露草稿存在性）
        probe("GET /api/v1/health-articles/{articleId}(不存在)",
                st(mockMvc.perform(get("/api/v1/health-articles/art-no-such")).andReturn()), 404);
        probe("GET /api/v1/health-articles/{articleId}(草稿)",
                st(mockMvc.perform(get("/api/v1/health-articles/art-hidden-1")).andReturn()), 404);
    }
}
