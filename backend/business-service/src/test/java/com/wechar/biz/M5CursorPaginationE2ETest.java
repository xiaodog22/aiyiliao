package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.servlet.MockMvc;

/**
 * cursor 分页 E2E（<b>只加测试，不改 keyset 实现</b>）。
 *
 * <p>种子共 7 条挂号（doc-gastro-1），期望顺序为 {@code (start_time DESC, id DESC)}：</p>
 * <pre>
 * ap-m5-d(01-05) → ap-m5-c(01-04) → ap-m5-b(01-03) → ap-m5-a(01-02)
 *   → 同一 start_time 组按 id DESC：ap-m5-t3 → ap-m5-t2 → ap-m5-t1
 * </pre>
 *
 * <p>覆盖：多页无重复无遗漏、相同时间边界稳定排序、limit+1 判页、末页 nextCursor、
 * 空列表、非法游标、limit 上下界收敛。</p>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m5-seed.sql",
        "app.rate-limit.enabled=false",
        "app.audit.enabled=false"
})
@AutoConfigureMockMvc
class M5CursorPaginationE2ETest {

    private static final String H2_URL =
            "jdbc:h2:mem:m5cursor;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                    + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1";

    /** 有 7 条挂号（含 3 条同 start_time）。 */
    private static final String DOCTOR = "dev-user-2";
    /** 有医生任职但零挂号。 */
    private static final String DOCTOR_EMPTY = "dev-user-3";

    private static final List<String> EXPECTED_ORDER = List.of(
            "ap-m5-d", "ap-m5-c", "ap-m5-b", "ap-m5-a", "ap-m5-t3", "ap-m5-t2", "ap-m5-t1");

    private final ObjectMapper json = new ObjectMapper();

    @Autowired
    private MockMvc mockMvc;

    @DynamicPropertySource
    static void properties(DynamicPropertyRegistry registry) {
        registry.add("spring.datasource.url", () -> H2_URL);
        registry.add("spring.datasource.username", () -> "sa");
        registry.add("spring.datasource.password", () -> "");
        registry.add("phone.key-base64", () -> "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=");
    }

    // ------------------------------------------------------ 多页：无重复无遗漏

    @Test
    void 多页翻完_无重复无遗漏_顺序与游标一致() throws Exception {
        List<String> collected = new ArrayList<>();
        List<Page> pages = new ArrayList<>();
        String cursor = null;
        for (int guard = 0; guard < 10; guard++) {
            Page page = fetch(DOCTOR, 3, cursor);
            pages.add(page);
            collected.addAll(page.ids());
            assertThat(page.ids().size()).as("单页不得超过 limit").isLessThanOrEqualTo(3);
            if (page.nextCursor() == null) {
                break;
            }
            cursor = page.nextCursor();
        }

        assertThat(pages).as("7 条 / 每页 3 条 = 3 页").hasSize(3);
        assertThat(pages.get(0).ids()).containsExactly("ap-m5-d", "ap-m5-c", "ap-m5-b");
        assertThat(pages.get(1).ids()).containsExactly("ap-m5-a", "ap-m5-t3", "ap-m5-t2");
        assertThat(pages.get(2).ids()).containsExactly("ap-m5-t1");
        assertThat(pages.get(0).nextCursor()).isNotNull();
        assertThat(pages.get(1).nextCursor()).isNotNull();
        assertThat(pages.get(2).nextCursor()).as("末页必须没有 nextCursor").isNull();

        assertThat(collected).containsExactlyElementsOf(EXPECTED_ORDER);
        assertThat(new HashSet<>(collected)).as("跨页不得重复").hasSize(EXPECTED_ORDER.size());
    }

    @Test
    void 相同start_time边界_按id倒序稳定_跨页不断裂() throws Exception {
        // limit=2 让分页边界正好落在同 start_time 组内部
        Page page1 = fetch(DOCTOR, 2, null);
        Page page2 = fetch(DOCTOR, 2, page1.nextCursor());
        Page page3 = fetch(DOCTOR, 2, page2.nextCursor());
        Page page4 = fetch(DOCTOR, 2, page3.nextCursor());

        assertThat(page1.ids()).containsExactly("ap-m5-d", "ap-m5-c");
        assertThat(page2.ids()).containsExactly("ap-m5-b", "ap-m5-a");
        assertThat(page3.ids()).containsExactly("ap-m5-t3", "ap-m5-t2");
        assertThat(page4.ids()).containsExactly("ap-m5-t1");
        assertThat(page4.nextCursor()).isNull();

        // 三条同时间记录的 startTime 必须完全一致（否则"同时间边界"前提不成立）
        List<String> tieTimes = new ArrayList<>();
        for (String id : List.of("ap-m5-t1", "ap-m5-t2", "ap-m5-t3")) {
            tieTimes.add(fetchById(id));
        }
        assertThat(new HashSet<>(tieTimes)).as("ap-m5-t1/t2/t3 应共用同一 start_time").hasSize(1);
    }

    // ------------------------------------------------------------- limit+1 判页

    @Test
    void limit加一判页_恰好等于limit时末页不给nextCursor() throws Exception {
        // 总数恰好等于 limit：实现若只取 limit 条就无法判断"是否还有"，limit+1 才能给出 nextCursor=null
        Page exact = fetch(DOCTOR, 7, null);
        assertThat(exact.ids()).containsExactlyElementsOf(EXPECTED_ORDER);
        assertThat(exact.nextCursor()).as("剩余数 == limit 时不得再给游标").isNull();

        // limit 小于总数：必须给出游标，且本页只有 limit 条（第 limit+1 条只能用于判页，不能出现在结果里）
        Page partial = fetch(DOCTOR, 4, null);
        assertThat(partial.ids()).hasSize(4);
        assertThat(partial.nextCursor()).isNotNull();

        // 用该游标续翻，剩余 3 条，无重复
        Page rest = fetch(DOCTOR, 4, partial.nextCursor());
        assertThat(rest.ids()).containsExactly("ap-m5-t3", "ap-m5-t2", "ap-m5-t1");
        assertThat(rest.nextCursor()).isNull();
        assertThat(new HashSet<>(partial.ids())).doesNotContainAnyElementsOf(rest.ids());
    }

    @Test
    void 表头total缺省时_仅凭nextCursor判页() throws Exception {
        // 契约 ApiMeta.total 可选且本实现不返回；客户端只能依赖 nextCursor
        String body = mockMvc.perform(get("/api/v1/doctor/appointments")
                        .header("X-User-Id", DOCTOR)
                        .param("limit", "3"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode root = json.readTree(body);
        assertThat(root.path("meta").path("total").isMissingNode()
                || root.path("meta").path("total").isNull()).isTrue();
        assertThat(root.path("meta").path("nextCursor").asText()).isNotBlank();
    }

    // ------------------------------------------------------------- 空列表与边界

    @Test
    void 空列表_返回空数组且无nextCursor() throws Exception {
        String body = mockMvc.perform(get("/api/v1/doctor/appointments")
                        .header("X-User-Id", DOCTOR_EMPTY)
                        .param("limit", "3"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").isArray())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);

        JsonNode root = json.readTree(body);
        assertThat(root.path("data")).isEmpty();
        assertThat(root.path("meta").path("nextCursor").isMissingNode()
                || root.path("meta").path("nextCursor").isNull())
                .as("空列表不得给出游标").isTrue();
    }

    @Test
    void 非法游标_422明确拒绝_不静默返回第一页() throws Exception {
        for (String illegal : List.of("!!!", "abc", "bm90LWEtY3Vyc29y")) {
            mockMvc.perform(get("/api/v1/doctor/appointments")
                            .header("X-User-Id", DOCTOR)
                            .param("limit", "3")
                            .param("cursor", illegal))
                    .andExpect(status().isUnprocessableEntity())
                    .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
        }
    }

    @Test
    void 空游标视为首页_不报错() throws Exception {
        Page page = fetch(DOCTOR, 3, "");
        assertThat(page.ids()).containsExactly("ap-m5-d", "ap-m5-c", "ap-m5-b");
    }

    @Test
    void limit收敛到1至50_不因越界报错() throws Exception {
        Page zero = fetch(DOCTOR, 0, null);
        assertThat(zero.ids()).as("limit<=0 收敛为 1").hasSize(1);
        assertThat(zero.ids()).containsExactly("ap-m5-d");

        Page huge = fetch(DOCTOR, 999, null);
        assertThat(huge.ids()).as("limit 上限 50 覆盖全部 7 条").hasSize(EXPECTED_ORDER.size());
        assertThat(huge.nextCursor()).isNull();
    }

    // ---------------------------------------------------------------- 辅助

    private record Page(List<String> ids, String nextCursor) {
    }

    private Page fetch(String userId, int limit, String cursor) throws Exception {
        var request = get("/api/v1/doctor/appointments")
                .header("X-User-Id", userId)
                .param("limit", String.valueOf(limit));
        if (cursor != null && !cursor.isEmpty()) {
            request = request.param("cursor", cursor);
        }
        String body = mockMvc.perform(request)
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        JsonNode root = json.readTree(body);
        List<String> ids = new ArrayList<>();
        for (JsonNode item : root.path("data")) {
            ids.add(item.path("id").asText());
        }
        JsonNode next = root.path("meta").path("nextCursor");
        String nextCursor = next.isMissingNode() || next.isNull() ? null : next.asText();
        return new Page(ids, nextCursor);
    }

    /** 取单条记录的 startTime（用于验证"同时间边界"前提）。 */
    private String fetchById(String id) throws Exception {
        String body = mockMvc.perform(get("/api/v1/doctor/appointments")
                        .header("X-User-Id", DOCTOR)
                        .param("limit", "50"))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString(StandardCharsets.UTF_8);
        for (JsonNode item : json.readTree(body).path("data")) {
            if (id.equals(item.path("id").asText())) {
                return item.path("startTime").asText();
            }
        }
        throw new AssertionError("未找到挂号 " + id);
    }
}
