package com.wechar.biz.bed;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.test.web.servlet.MockMvc;

/**
 * 审计 F1-3 回归：strict 档下护士站终端令牌必须能到达 NurseStationGuard。
 *
 * <p>修复前这些路径不在 AuthInterceptor 白名单 → 先被 401，护士站静态页整体不可用。
 * 修复后仍不是"匿名可读"：无令牌/错令牌由控制器返回 403（本类同时断言这一点）。</p>
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:nursestrict;MODE=MySQL;DATABASE_TO_LOWER=TRUE;"
                + "CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m2-seed.sql",
        "app.auth.mode=strict",
        "app.nurse.station-token=test-nurse-token-0123456789"
})
@AutoConfigureMockMvc
class NurseStationStrictAuthTest {

    private static final String TOKEN = "test-nurse-token-0123456789";

    @Autowired
    private MockMvc mockMvc;

    @Test
    void 终端令牌通过strict拦截_无令牌仍然403() throws Exception {
        mockMvc.perform(get("/api/v1/nurse/beds").header("X-Nurse-Station-Token", TOKEN))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.code").value("OK"));

        // 放行 ≠ 免鉴权：没带终端令牌必须 403，而不是 401/200
        mockMvc.perform(get("/api/v1/nurse/beds"))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }
}
