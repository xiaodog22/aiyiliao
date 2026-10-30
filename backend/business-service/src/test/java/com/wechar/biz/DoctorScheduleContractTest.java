package com.wechar.biz;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.put;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.autoconfigure.web.servlet.AutoConfigureMockMvc;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.MvcResult;

/**
 * 排班与在线接诊契约测试（V22，2026-10-22）。
 *
 * 覆盖：
 *  - GET /doctor/schedule：空排班 version=0；无医生任职 → 403；
 *  - PUT /doctor/schedule：创建、整体替换、乐观锁 409、同内容重试回放 200、
 *    时段重叠 422 SCHEDULE_OVERLAP、slotMinutes 非法 422；
 *  - POST /doctor/online-status：上线 accepting=true；下线双 false；
 *  - GET /doctors/{id}/availability：公开（无身份头可读）、nextSlotAt 非空。
 *
 * 数据：test-m1-seed.sql 的 doc-gastro-1 + u-dev-user-1（本类在 @BeforeEach 建立任职关联）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:schedtest;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@AutoConfigureMockMvc
class DoctorScheduleContractTest {

    private static final String USER = "u-dev-user-1";
    private static final String OTHER = "u-bound-user";
    private static final String DOCTOR = "doc-gastro-1";

    /** 两天：周一上午一段；周五上午 + 下午（下午仅在线问诊）。 */
    private static final String SCHEDULE_V1 = """
            {"expectedVersion":0,"weekdays":[
              {"weekday":1,"slots":[{"startTime":"09:00","endTime":"12:00","slotMinutes":30,"capacity":3}]},
              {"weekday":5,"slots":[
                 {"startTime":"09:00","endTime":"12:00","slotMinutes":30,"capacity":2},
                 {"startTime":"14:00","endTime":"17:00","slotMinutes":60,"capacity":1,"onlineOnly":true}]}]}
            """;

    @Autowired
    private MockMvc mockMvc;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void resetScheduleState() {
        jdbc.update("DELETE FROM doctor_schedules WHERE doctor_id = ?", DOCTOR);
        jdbc.update("DELETE FROM doctor_online_status WHERE doctor_id = ?", DOCTOR);
        // 本类用 u-dev-user-1 作为该医生的登录账号（m1 种子未建任职关联）
        jdbc.update("UPDATE doctors SET user_id = ? WHERE id = ?", USER, DOCTOR);
    }

    private MvcResult putSchedule(String body, String key) throws Exception {
        return mockMvc.perform(put("/api/v1/doctor/schedule")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", key)
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(body))
                .andReturn();
    }

    // ---------------------------------------------------------------- GET

    @Test
    void 无排班时_version为0_weekdays为空数组() throws Exception {
        mockMvc.perform(get("/api/v1/doctor/schedule").header("X-User-Id", USER))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.version").value(0))
                .andExpect(jsonPath("$.data.weekdays.length()").value(0))
                .andExpect(jsonPath("$.data.online.online").value(false))
                .andExpect(jsonPath("$.data.online.accepting").value(false));
    }

    @Test
    void 非医生账号_403() throws Exception {
        mockMvc.perform(get("/api/v1/doctor/schedule").header("X-User-Id", OTHER))
                .andExpect(status().isForbidden())
                .andExpect(jsonPath("$.code").value("FORBIDDEN"));
    }

    // ---------------------------------------------------------------- PUT

    @Test
    void 创建周模板_整体替换_版本递增() throws Exception {
        MvcResult created = putSchedule(SCHEDULE_V1, "sched-key-0001");
        org.assertj.core.api.Assertions.assertThat(created.getResponse().getStatus()).isEqualTo(200);
        String body = created.getResponse().getContentAsString(StandardCharsets.UTF_8);
        org.assertj.core.api.Assertions.assertThat(body).contains("\"version\":1");
        org.assertj.core.api.Assertions.assertThat(body).contains("\"weekday\":1");
        org.assertj.core.api.Assertions.assertThat(body).contains("\"onlineOnly\":true");

        // 整体替换：只留周一一段，周五两天记录应被删除
        String replace = """
                {"expectedVersion":1,"weekdays":[
                  {"weekday":3,"slots":[{"startTime":"08:30","endTime":"10:00","slotMinutes":15,"capacity":5}]}]}
                """;
        mockMvc.perform(put("/api/v1/doctor/schedule")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "sched-key-0002")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(replace))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.version").value(2))
                .andExpect(jsonPath("$.data.weekdays.length()").value(1))
                .andExpect(jsonPath("$.data.weekdays[0].weekday").value(3))
                .andExpect(jsonPath("$.data.weekdays[0].slots[0].slotMinutes").value(15));
    }

    @Test
    void 版本过期_409() throws Exception {
        putSchedule(SCHEDULE_V1, "sched-key-0010");
        // 当前版本 1，却仍按 expectedVersion=0 提交且内容不同 → 冲突
        String different = """
                {"expectedVersion":0,"weekdays":[
                  {"weekday":2,"slots":[{"startTime":"09:00","endTime":"10:00","slotMinutes":30,"capacity":1}]}]}
                """;
        mockMvc.perform(put("/api/v1/doctor/schedule")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "sched-key-0011")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(different))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.code").value("VERSION_CONFLICT"));
    }

    @Test
    void 同内容重试按成功回放_不回409() throws Exception {
        putSchedule(SCHEDULE_V1, "sched-key-0020");
        // 客户端超时重试：同一个 body、同一个 expectedVersion=0
        mockMvc.perform(put("/api/v1/doctor/schedule")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "sched-key-0020")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(SCHEDULE_V1))
                .andExpect(status().isOk())
                .andExpect(header().string("Idempotency-Replayed", "true"))
                .andExpect(jsonPath("$.data.version").value(1));
    }

    @Test
    void 同天时段重叠_422() throws Exception {
        String overlap = """
                {"expectedVersion":0,"weekdays":[
                  {"weekday":1,"slots":[
                     {"startTime":"09:00","endTime":"12:00","slotMinutes":30,"capacity":1},
                     {"startTime":"11:00","endTime":"13:00","slotMinutes":30,"capacity":1}]}]}
                """;
        mockMvc.perform(put("/api/v1/doctor/schedule")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "sched-key-0030")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(overlap))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("SCHEDULE_OVERLAP"));
    }

    @Test
    void slotMinutes非白名单_422() throws Exception {
        String bad = """
                {"expectedVersion":0,"weekdays":[
                  {"weekday":1,"slots":[{"startTime":"09:00","endTime":"10:00","slotMinutes":45,"capacity":1}]}]}
                """;
        mockMvc.perform(put("/api/v1/doctor/schedule")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "sched-key-0040")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(bad))
                .andExpect(status().isUnprocessableEntity())
                .andExpect(jsonPath("$.code").value("VALIDATION_FAILED"));
    }

    // ---------------------------------------------------------------- 在线状态

    @Test
    void 上线后_accepting为true_下线后双false() throws Exception {
        putSchedule(SCHEDULE_V1, "sched-key-0050");
        mockMvc.perform(post("/api/v1/doctor/online-status")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "online-key-0001")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"online\":true}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.online").value(true))
                .andExpect(jsonPath("$.data.accepting").value(true));

        mockMvc.perform(post("/api/v1/doctor/online-status")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "online-key-0002")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"online\":false}"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.online").value(false))
                .andExpect(jsonPath("$.data.accepting").value(false));
    }

    // ---------------------------------------------------------------- 患者侧

    @Test
    void 患者侧availability_公开可读_并给出下次出诊时间() throws Exception {
        putSchedule(SCHEDULE_V1, "sched-key-0060");
        mockMvc.perform(post("/api/v1/doctor/online-status")
                        .header("X-User-Id", USER)
                        .header("Idempotency-Key", "online-key-0010")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{\"online\":true}"))
                .andExpect(status().isOk());

        // 不带任何身份头：公开只读（与 /slots 同口径）
        mockMvc.perform(get("/api/v1/doctors/" + DOCTOR + "/availability"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.data.doctorId").value(DOCTOR))
                .andExpect(jsonPath("$.data.online").value(true))
                .andExpect(jsonPath("$.data.accepting").value(true))
                .andExpect(jsonPath("$.data.nextSlotAt").isNotEmpty());
    }
}
