package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;

import com.wechar.biz.appointment.AppointmentService;
import com.wechar.biz.catalog.CatalogService;
import com.wechar.biz.home.HomeService;
import com.wechar.biz.message.MessageService;
import com.wechar.biz.support.QueryCounter;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.function.Supplier;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.context.annotation.Import;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 端点级 SQL 画像（2026-11-01，配合 PERF-09 收尾）。
 *
 * **为什么需要它**：全局 8.92 次/请求只是混合场景的平均值，它对"哪个端点最贵"毫无信息量。
 * 一个 1 次的端点和 20 次的端点在平均值里可以互相抵消，而容量规划关心的是**最贵的那个**——
 * 换反代层把 RPS 拉到 1000+ 时，DB 压力由最贵的端点乘以它的调用占比决定，不由平均值决定。
 *
 * **同时回答一个具体质疑**：8.92 是否只是 N+1 的遗留，还是"某些端点本来就该多查几次"。
 * 逐个测完就能区分：
 *   - 若某端点次数**随数据量增长** → 仍是 N+1 形态，是缺陷；
 *   - 若次数**固定但偏高** → 可能是必要业务查询，也可能可合并，需要看具体 SQL。
 *
 * 断言口径与 {@code DoctorQueryBudgetTest} 一致：锁"上限"，不锁精确值——
 * 精确值会随实现微调而红，上限才能表达"这个端点允许多少次往返"的架构约束。
 *
 * ⚠️ 每个端点都先 reset 再调用，避免前一个端点的计数污染后一个。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:endpointsqlprofile;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
@Import(DoctorQueryBudgetTest.CountingConfig.class)
class EndpointSqlProfileTest {

    /** 各端点的 SQL 预算（次/请求）。超了说明引入 N+1 或多余往返。 */
    private static final Map<String, Integer> BUDGET = Map.of(
            "GET /departments", 2,
            "GET /doctors", 3,
            "GET /messages/unread-count", 2,
            "GET /appointments/me", 6,
            "GET /home/summary", 8
    );

    private static final String USER = "u-dev-user-1";

    @Autowired
    private QueryCounter counter;

    @Autowired
    private CatalogService catalog;

    @Autowired
    private MessageService messages;

    @Autowired
    private HomeService home;

    @Autowired
    private AppointmentService appointments;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    @DisplayName("端点级 SQL 画像：逐个测量并守住上限（不是只看全局平均）")
    void profile_each_read_endpoint() {
        Map<String, Supplier<?>> endpoints = new LinkedHashMap<>();
        endpoints.put("GET /departments", () -> catalog.departments(null, null));
        endpoints.put("GET /doctors", () -> catalog.allDoctors(null));
        endpoints.put("GET /messages/unread-count", () -> messages.unreadCount(USER));
        endpoints.put("GET /appointments/me", () -> appointments.list(USER, null, 20));
        endpoints.put("GET /home/summary", () -> home.summary(USER));

        Map<String, Integer> measured = new LinkedHashMap<>();
        for (Map.Entry<String, Supplier<?>> e : endpoints.entrySet()) {
            counter.reset();
            Object result = e.getValue().get();
            int sql = counter.count();
            measured.put(e.getKey(), sql);
            // 打印成表，便于人工看画像（CI 日志里也能读）
            System.out.printf("[sql-profile] %-28s %2d 次 SQL%n", e.getKey(), sql);
            assertThat(result).as("%s 必须返回非 null，否则测量无意义", e.getKey()).isNotNull();
        }

        int total = measured.values().stream().mapToInt(Integer::intValue).sum();
        System.out.printf("[sql-profile] 五端点合计 %d 次，最高为 %s%n", total, argmax(measured));

        for (Map.Entry<String, Integer> e : measured.entrySet()) {
            Integer budget = BUDGET.get(e.getKey());
            if (budget == null) continue;
            assertThat(e.getValue())
                    .as("%s 的 SQL 次数 %d 超出预算 %d——请确认是否新引入 N+1（次数应不随数据量增长）",
                            e.getKey(), e.getValue(), budget)
                    .isLessThanOrEqualTo(budget);
        }
    }

    @Test
    @DisplayName("对照：同一端点在数据量翻倍后 SQL 次数不变（证明没有隐藏 N+1）")
    void endpoint_sql_count_is_independent_of_row_count() {
        // 选最贵的 home/summary：它聚合了 appointment / content / config 三条链路，
        // 是最可能藏 N+1 的地方。给它加 5 条预约，看 SQL 次数是否变化。
        counter.reset();
        home.summary(USER);
        int before = counter.count();

        String slotId = jdbc.queryForObject(
                "SELECT id FROM doctor_slots LIMIT 1", String.class);
        // doctor_id / department_id 在 appointments 是 VARCHAR(64)，不是数字
        String doctorId = jdbc.queryForObject(
                "SELECT doctor_id FROM doctor_slots WHERE id = ?", String.class, slotId);
        String deptId = jdbc.queryForObject(
                "SELECT department_id FROM doctors WHERE id = ?", String.class, doctorId);

        for (int i = 0; i < 5; i++) {
            // idempotency_key / request_digest 是 NOT NULL，必须给值（uk_appointments_idem 要求 user 内唯一）
            jdbc.update("INSERT INTO appointments (id, user_id, slot_id, doctor_id, department_id, "
                            + "patient_name, status, queue_number, idempotency_key, request_digest, "
                            + "version, created_at, updated_at) "
                            + "VALUES (?, ?, ?, ?, ?, ?, 'CONFIRMED', ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)",
                    "appt-sqlprofile-" + i, USER, slotId, doctorId, deptId, "画像测试患者", 100 + i,
                    "ik-sqlprofile-" + i, "digest-" + i);
        }

        try {
            counter.reset();
            home.summary(USER);
            int after = counter.count();
            assertThat(after)
                    .as("预约从 1 条增到 6 条后，home/summary 的 SQL 次数不得增长（%d → %d）", before, after)
                    .isEqualTo(before);
        } finally {
            jdbc.update("DELETE FROM appointments WHERE id LIKE 'appt-sqlprofile-%'");
        }
    }

    private static String argmax(Map<String, Integer> m) {
        return m.entrySet().stream()
                .max(Map.Entry.comparingByValue())
                .map(e -> e.getKey() + "（" + e.getValue() + " 次）")
                .orElse("—");
    }
}
