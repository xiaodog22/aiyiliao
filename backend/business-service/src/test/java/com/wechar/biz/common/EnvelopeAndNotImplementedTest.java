package com.wechar.biz.common;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 骨架行为测试：未实现端点体面返回 + requestId 贯穿 + 统一信封。
 * M3 后 doctor/beds/consents/deletion-requests 均已实现，此处的 501 基线改用
 * **业务后端本就不提供**的契约路径：
 *  - GET  /api/gw/*（契约 x-served-by: edge-gateway，由网关进程提供）；
 *  - POST /internal/v1/callbacks/task-events（契约 x-status: provisional，O-02 定稿前不得实现）。
 * 用完整上下文（独立 H2，不带种子数据）：@WebMvcTest 会装载全部 @RestController，
 * 而其依赖的服务层不在切片内；完整上下文同时验证 throw-exception-if-no-handler-found 链路。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m1web;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=never"
})
@AutoConfigureMockMvc
class EnvelopeAndNotImplementedTest {

    @Autowired
    private MockMvc mockMvc;

    @Test
    void 未实现路径返回NOT_IMPLEMENTED而非空200() throws Exception {
        // /api/gw/* 由网关进程提供，业务后端不应有 handler → 可识别的 501
        mockMvc.perform(get("/api/gw/health"))
                .andExpect(status().isNotImplemented())
                .andExpect(jsonPath("$.code").value("NOT_IMPLEMENTED"))
                .andExpect(jsonPath("$.requestId").isNotEmpty())
                .andExpect(jsonPath("$.serverTime").isNotEmpty())
                .andExpect(jsonPath("$.retryable").value(false));
    }

    @Test
    void requestId_回显客户端值并写入响应头() throws Exception {
        mockMvc.perform(get("/api/gw/health").header("X-Request-Id", "trace-12345678"))
                .andExpect(header().string("X-Request-Id", "trace-12345678"))
                .andExpect(jsonPath("$.requestId").value("trace-12345678"));
    }

    @Test
    void 未实现的POST端点同样返回NOT_IMPLEMENTED而非空200() throws Exception {
        // O-02 定稿前不得实现内部回调端点（契约 x-status: provisional）→ 保持 501
        mockMvc.perform(post("/internal/v1/callbacks/task-events").contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isNotImplemented())
                .andExpect(jsonPath("$.code").value("NOT_IMPLEMENTED"));
    }
}
