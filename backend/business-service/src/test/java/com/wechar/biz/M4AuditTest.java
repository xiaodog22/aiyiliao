package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

/**
 * M4 审计测试（08B §M4「审计」+ docs/v4/03 §39/§147）。
 *
 * 断言矩阵：
 *  1. 写操作成功（POST 健康档案）→ 记一条 SUCCESS，actor 为认证主体；
 *  2. 鉴权拒绝（无身份访问受保护路径）→ 记一条 DENIED（安全证据，401 必须留痕）；
 *  3. 只读成功（GET /departments）→ 不记录（避免低配刷表）；
 *  4. **不落正文**：请求体中的敏感词（症状/手机号）绝不进入 audit_events 任何列；
 *  5. action 存路径模板（含 {purpose} 等占位），对象 ID 不作为无界键灌入 action。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4audittest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class M4AuditTest {

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private org.springframework.jdbc.core.JdbcTemplate jdbc;

    @Test
    void 写操作成功_记录SUCCESS且主体为认证用户() throws Exception {
        int before = count("action = 'POST /api/v1/health-records'");
        mockMvc.perform(post("/api/v1/health-records")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4-audit-hr-0001")
                        .content("{\"category\":\"VITALS\",\"title\":\"晨起血压\",\"recordedAt\":\"2026-01-01T08:00:00Z\"}"))
                .andExpect(status().isOk());
        Integer after = count("action = 'POST /api/v1/health-records'");
        org.assertj.core.api.Assertions.assertThat(after).isEqualTo(before + 1);

        var row = jdbc.queryForMap("SELECT actor_user_id, object_type, outcome, status_code, request_id "
                + "FROM audit_events WHERE action = 'POST /api/v1/health-records' "
                + "ORDER BY server_time DESC, id DESC LIMIT 1");
        org.assertj.core.api.Assertions.assertThat(row.get("actor_user_id")).isEqualTo("u-dev-user-1");
        org.assertj.core.api.Assertions.assertThat(row.get("object_type")).isEqualTo("health-records");
        org.assertj.core.api.Assertions.assertThat(row.get("outcome")).isEqualTo("SUCCESS");
        org.assertj.core.api.Assertions.assertThat(row.get("status_code")).isEqualTo(200);
        org.assertj.core.api.Assertions.assertThat(String.valueOf(row.get("request_id"))).isNotBlank();
    }

    @Test
    void 鉴权拒绝_记录DENIED_作为安全证据() throws Exception {
        int before = count("outcome = 'DENIED'");
        mockMvc.perform(get("/api/v1/appointments/me"))
                .andExpect(status().isUnauthorized());
        Integer after = count("outcome = 'DENIED'");
        org.assertj.core.api.Assertions.assertThat(after).isEqualTo(before + 1);

        var row = jdbc.queryForMap("SELECT actor_user_id, action, status_code FROM audit_events "
                + "WHERE outcome = 'DENIED' ORDER BY server_time DESC, id DESC LIMIT 1");
        org.assertj.core.api.Assertions.assertThat(row.get("actor_user_id")).isNull();
        org.assertj.core.api.Assertions.assertThat(row.get("action")).isEqualTo("GET /api/v1/appointments/me");
        org.assertj.core.api.Assertions.assertThat(row.get("status_code")).isEqualTo(401);
    }

    @Test
    void 只读成功_不记录() throws Exception {
        int before = count("action = 'GET /api/v1/departments'");
        mockMvc.perform(get("/api/v1/departments")).andExpect(status().isOk());
        Integer after = count("action = 'GET /api/v1/departments'");
        org.assertj.core.api.Assertions.assertThat(after).isEqualTo(before);
    }

    @Test
    void 审计不落正文_症状与手机号不进任何列() throws Exception {
        String symptom = "间歇性胸闷伴左臂放射痛ST段压低";
        String phone = "13900001234";
        mockMvc.perform(post("/api/v1/triage/recommendations")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .content("{\"symptoms\":\"" + symptom + "\",\"contactPhone\":\"" + phone + "\"}"))
                .andExpect(status().isOk());
        // 全表逐列扫描：敏感正文不得出现在 audit_events 任一列
        var rows = jdbc.queryForList("SELECT * FROM audit_events");
        org.assertj.core.api.Assertions.assertThat(rows).isNotEmpty();
        for (var r : rows) {
            for (var v : r.values()) {
                if (v != null) {
                    String s = String.valueOf(v);
                    org.assertj.core.api.Assertions.assertThat(s)
                            .as("audit_events 泄漏正文: %s", s)
                            .doesNotContain(symptom)
                            .doesNotContain(phone)
                            .doesNotContain("放射痛");
                }
            }
        }
        // 该 triage 写操作本身留痕（模板化 action，不含请求体）
        Integer n = count("action = 'POST /api/v1/triage/recommendations'");
        org.assertj.core.api.Assertions.assertThat(n).isGreaterThanOrEqualTo(1);
    }

    @Test
    void action取路径模板_对象ID不灌入action列() throws Exception {
        // 先授权再撤回（m1 种子无 consent 行）
        mockMvc.perform(post("/api/v1/consents")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4-audit-grant-0001")
                        .content("{\"purpose\":\"HEALTH_DATA_PROCESSING\",\"policyVersion\":\"v1.0\",\"channel\":\"MINIPROGRAM\"}"))
                .andExpect(status().isOk());
        int before = count("action = 'POST /api/v1/consents/{purpose}/withdraw'");
        mockMvc.perform(post("/api/v1/consents/HEALTH_DATA_PROCESSING/withdraw")
                        .contentType(MediaType.APPLICATION_JSON)
                        .header("X-User-Id", "dev-user-1")
                        .header("Idempotency-Key", "m4-audit-wd-0001")
                        .content("{\"reason\":\"不再需要\"}"))
                .andExpect(status().isOk());
        org.assertj.core.api.Assertions.assertThat(
                        count("action = 'POST /api/v1/consents/{purpose}/withdraw'"))
                .isEqualTo(before + 1);
        var row = jdbc.queryForMap("SELECT action, object_type FROM audit_events "
                + "WHERE action = 'POST /api/v1/consents/{purpose}/withdraw' "
                + "ORDER BY server_time DESC, id DESC LIMIT 1");
        org.assertj.core.api.Assertions.assertThat(row.get("action"))
                .isEqualTo("POST /api/v1/consents/{purpose}/withdraw");
        org.assertj.core.api.Assertions.assertThat(row.get("object_type")).isEqualTo("consents");
    }

    @Test
    void 审计只追加_无update_delete入口() {
        // 结构性断言：AuditLog/AuditInterceptor 源码不含 UPDATE/DELETE 语句（防篡改口径）
        String auditLog = read("com/wechar/biz/common/AuditLog.java");
        String auditIcpt = read("com/wechar/biz/common/AuditInterceptor.java");
        org.assertj.core.api.Assertions.assertThat(auditLog)
                .doesNotContain("UPDATE audit_events")
                .doesNotContain("DELETE FROM audit_events")
                .contains("INSERT INTO audit_events");
        org.assertj.core.api.Assertions.assertThat(auditIcpt)
                .doesNotContain("UPDATE audit_events")
                .doesNotContain("DELETE FROM audit_events");
    }

    private int count(String where) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM audit_events WHERE " + where, Integer.class);
        return n == null ? 0 : n;
    }

    private static String read(String srcRelPath) {
        java.nio.file.Path p = java.nio.file.Path.of("src", "main", "java",
                srcRelPath.replace('/', java.io.File.separatorChar));
        org.assertj.core.api.Assertions.assertThat(p).as("找不到源码 %s", srcRelPath).exists();
        try {
            return java.nio.file.Files.readString(p, java.nio.charset.StandardCharsets.UTF_8);
        } catch (java.io.IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
