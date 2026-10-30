package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.sql.Timestamp;
import java.time.Instant;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 消息中心契约测试（V21 新增端点的防回归探针，2026-10-23 补齐）。
 *
 * 覆盖前端红点提示与消息列表消费依赖的三个端点：
 *  GET  /api/v1/messages             列表（cursor 分页，新→旧）
 *  GET  /api/v1/messages/unread-count 未读数（红点唯一数据源）
 *  POST /api/v1/messages/{id}/read   标记已读（幂等；他人消息/不存在同一 200，不泄露存在性）
 *
 * 数据：test-m1-seed.sql（u-dev-user-1 / u-bound-user）；身份经 X-User-Id 头注入（itest profile）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:mmsg;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class MessageCenterContractTest {

    private static final String USER = "u-dev-user-1";
    private static final String OTHER = "u-bound-user";

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    /** 方法间隔离：清空 messages（seed 不含消息数据，各用例自行插入；避免共享 H2 累积）。 */
    @BeforeEach
    void cleanMessages() {
        jdbc.update("DELETE FROM messages");
    }

    private void insertMessage(String id, String userId, String type, String title,
                               String body, Instant createdAt, Instant readAt) {
        jdbc.update(
                "INSERT INTO messages (id, user_id, type, title, body, read_at, created_at) "
                        + "VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, userId, type, title, body,
                readAt == null ? null : Timestamp.from(readAt), Timestamp.from(createdAt));
    }

    @Test
    void 空列表_返回200与空items() throws Exception {
        mockMvc.perform(get("/api/v1/messages").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"))
                .andExpect(jsonPath("$.data").isArray())
                .andExpect(jsonPath("$.data.length()").value(0))
                .andExpect(jsonPath("$.meta.nextCursor").doesNotExist());
    }

    @Test
    void 无消息_未读数为0() throws Exception {
        mockMvc.perform(get("/api/v1/messages/unread-count").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").value(0));
    }

    @Test
    void 列表_新到旧_未读与已读都在() throws Exception {
        Instant now = Instant.parse("2026-10-23T03:00:00Z");
        insertMessage("msg-old-1", USER, "SYSTEM", "旧消息", "旧", now.minusSeconds(600), now.minusSeconds(300));
        insertMessage("msg-new-2", USER, "APPOINTMENT", "新消息", "新", now, null);

        mockMvc.perform(get("/api/v1/messages").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.length()").value(2))
                .andExpect(jsonPath("$.data[0].id").value("msg-new-2"))
                .andExpect(jsonPath("$.data[0].read").value(false))
                .andExpect(jsonPath("$.data[1].id").value("msg-old-1"))
                .andExpect(jsonPath("$.data[1].read").value(true));
    }

    @Test
    void 未读数_只计未读() throws Exception {
        Instant now = Instant.parse("2026-10-23T03:00:00Z");
        insertMessage("msg-u-1", USER, "SYSTEM", "未读一", "a", now.minusSeconds(60), null);
        insertMessage("msg-r-1", USER, "SYSTEM", "已读一", "b", now.minusSeconds(30), now);
        insertMessage("msg-u-2", USER, "SYSTEM", "未读二", "c", now, null);
        // 他人消息不影响本用户未读数（范围过滤在 SQL 条件内）
        insertMessage("msg-other", OTHER, "SYSTEM", "别人的", "d", now, null);

        mockMvc.perform(get("/api/v1/messages/unread-count").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").value(2));
    }

    @Test
    void 标记已读_幂等_且未读数归零() throws Exception {
        Instant now = Instant.parse("2026-10-23T03:00:00Z");
        insertMessage("msg-read-1", USER, "SYSTEM", "待读", "x", now, null);

        mockMvc.perform(post("/api/v1/messages/msg-read-1/read").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").value(true));

        mockMvc.perform(get("/api/v1/messages/unread-count").header("X-User-Id", USER))
                .andExpect(jsonPath("$.data").value(0));

        // 重复标记：幂等 200（返回 false = 无新变更，不报错、不重复计）
        mockMvc.perform(post("/api/v1/messages/msg-read-1/read").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").value(false));
    }

    @Test
    void 标记他人的消息_与不存在一样_返回200不泄露存在性() throws Exception {
        insertMessage("msg-other-2", OTHER, "SYSTEM", "别人的", "y", Instant.now(), null);

        mockMvc.perform(post("/api/v1/messages/msg-other-2/read").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data").value(false));

        // 他人的消息未读数视角不变（0），且该消息仍未读（数据未被动过）
        mockMvc.perform(get("/api/v1/messages/unread-count").header("X-User-Id", USER))
                .andExpect(jsonPath("$.data").value(0));
        Integer readCount = jdbc.queryForObject(
                "SELECT COUNT(*) FROM messages WHERE id = 'msg-other-2' AND read_at IS NOT NULL",
                Integer.class);
        org.assertj.core.api.Assertions.assertThat(readCount).isZero();
    }

    @Test
    void messageId非法_返回422() throws Exception {
        mockMvc.perform(post("/api/v1/messages/" + "a".repeat(65) + "/read").header("X-User-Id", USER))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }
}
