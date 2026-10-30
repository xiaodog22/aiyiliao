package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.wechar.biz.bed.BedService;
import com.wechar.biz.bed.dto.BedAssignmentRequest;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.doctor.DoctorService;
import com.wechar.biz.doctor.dto.AppointmentStatusUpdateRequest;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * M4.6 乐观锁并发专项（docs/v4/08B §M4「乐观锁并发」，真实并发，非 Mock）：
 * 8 线程同时以 expectedVersion=1 抢同一资源（各带独立幂等键，只让版本竞争说话）。
 * 目标语义：原子 UPDATE ... WHERE version=expected 恰 1 线程成功（0 行 → 409 VERSION_CONFLICT）；
 * 终态版本恰 +1；伴随事件（状态流转/床位变更日志）恰 1 条。
 * 数据：test-m3-seed.sql（ap-m3-1 PENDING v1；bed-gastro-a-01 AVAILABLE v1；
 * doc-gastro-1 → dev-user-2 任职）。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4conc-ver;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m3-seed.sql"
})
class M4ConcurrencyVersionTest {

    private static final int THREADS = 8;
    /** 直调 service 须传业务主键（openid→u- 映射发生在 HTTP 鉴权层）。 */
    private static final String USER_DOCTOR = "u-dev-user-2";

    @Autowired
    private DoctorService doctorService;

    @Autowired
    private BedService bedService;

    @Autowired
    private JdbcTemplate jdbc;

    private static <T> Map<String, Integer> race(Callable<T> call) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        CountDownLatch start = new CountDownLatch(1);
        Map<String, Integer> codes = new ConcurrentHashMap<>();
        try {
            List<Future<T>> futures = new ArrayList<>();
            for (int i = 0; i < THREADS; i++) {
                final String idempotencyKey = "m4cnc-" + UUID.randomUUID();
                futures.add(pool.submit(() -> {
                    start.await();
                    try {
                        T result = call.call();
                        codes.merge("OK", 1, Integer::sum);
                        return result;
                    } catch (ApiException e) {
                        codes.merge(e.getCode() + ":" + e.getStatus().value(), 1, Integer::sum);
                        return null;
                    } catch (RuntimeException e) {
                        codes.merge("UNEXPECTED:" + e.getClass().getSimpleName(), 1, Integer::sum);
                        return null;
                    }
                }));
            }
            start.countDown();
            for (Future<T> f : futures) {
                f.get(30, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }
        return codes;
    }

    private static void assertNoUnexpected(Map<String, Integer> codes) {
        codes.keySet().stream()
                .filter(code -> code.startsWith("UNEXPECTED:"))
                .findFirst()
                .ifPresent(code -> {
                    throw new AssertionError("并发出现非结构化失败 " + code + "，实测分布 " + codes);
                });
    }

    /** 胜者恰 1 个；其余全部为结构化 409（VERSION_CONFLICT / 状态机冲突等竞态次序差异皆合法）。 */
    private static void assertOneWinnerAll409(Map<String, Integer> codes) {
        assertNoUnexpected(codes);
        long wins = codes.getOrDefault("OK", 0);
        assertEquals(1, wins, "恰 1 线程胜出，实测分布 " + codes);
        long conflicts = codes.entrySet().stream()
                .filter(e -> e.getKey().endsWith(":409"))
                .mapToInt(Map.Entry::getValue).sum();
        assertEquals(THREADS - 1, conflicts, "其余应全部为结构化 409，实测分布 " + codes);
    }

    @Test
    void 挂号状态流转_8线程抢v1_恰1成功() throws Exception {
        Map<String, Integer> codes = race(() -> doctorService.updateStatus(USER_DOCTOR, "ap-m3-1",
                UUID.randomUUID().toString(),
                new AppointmentStatusUpdateRequest("CONFIRMED", 1, "并发探针")));
        assertOneWinnerAll409(codes);

        // 终态：version=2、CONFIRMED、事件恰 1 条
        Map<String, Object> row = jdbc.queryForMap(
                "SELECT status, version FROM appointments WHERE id = 'ap-m3-1'");
        assertEquals("CONFIRMED", String.valueOf(row.get("status")));
        assertEquals(2, ((Number) row.get("version")).intValue(), "实测分布 " + codes);
        Integer events = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointment_status_events WHERE appointment_id = 'ap-m3-1'",
                Integer.class);
        assertEquals(1, events, "状态事件恰 1 条，实测分布 " + codes);
    }

    @Test
    void 床位分配_8线程抢v1_恰1成功() throws Exception {
        Map<String, Integer> codes = race(() -> bedService.assign(USER_DOCTOR, "bed-gastro-a-01",
                UUID.randomUUID().toString(),
                new BedAssignmentRequest("ASSIGN", "u-m3-patient", 1, "并发探针")));
        assertOneWinnerAll409(codes);

        Map<String, Object> row = jdbc.queryForMap(
                "SELECT status, version, occupant_user_id FROM beds WHERE id = 'bed-gastro-a-01'");
        assertEquals("OCCUPIED", String.valueOf(row.get("status")));
        assertEquals(2, ((Number) row.get("version")).intValue(), "实测分布 " + codes);
        assertEquals("u-m3-patient", String.valueOf(row.get("occupant_user_id")));
    }
}
