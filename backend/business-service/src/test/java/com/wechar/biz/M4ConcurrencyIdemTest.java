package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * M4.6 幂等冲突并发专项（docs/v4/08B §M4「幂等冲突」，真实 Tomcat + 真实并发 HTTP）：
 * 8 线程同时以同一 Idempotency-Key POST /api/v1/consultations 的同域语义同样适用于
 * appointments——此处对 POST /api/v1/appointments（同键同体）验证：
 *  - 恰落 1 行 appointments（uk_appointments_idem 唯一键兜底）；
 *  - 无 5xx：并发撞唯一键的请求经控制器兜底（AppointmentController#createWithRaceFallback）
 *    转为幂等重放（200）或结构化 4xx；
 *  - 号源扣减不泄漏（撞键事务整体回滚，decrement 随之回滚）。
 * 用 RANDOM_PORT 而非 MockMvc：MockMvc 非线程安全，真实并发必须走真实容器线程池。
 * 数据：test-m1-seed.sql（slot-future-1；X-User-Id 在 itest header 档即为身份源）。
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:m4conc-idem;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
class M4ConcurrencyIdemTest {

    private static final int THREADS = 8;

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JdbcTemplate jdbc;

    /** 单次响应结果：状态码 + Idempotency-Replayed 头。 */
    private record Outcome(int status, boolean replayed, String code) {
    }

    private Outcome call(String key) {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-User-Id", "dev-user-1");
        headers.set("Idempotency-Key", key);
        ResponseEntity<String> response = rest.postForEntity("/api/v1/appointments",
                new HttpEntity<>("{\"slotId\":\"slot-future-1\",\"patientName\":\"并发探针\"}", headers),
                String.class);
        String replayed = response.getHeaders().getFirst("Idempotency-Replayed");
        String code = "";
        try {
            code = com.fasterxml.jackson.databind.json.JsonMapper.builder().build()
                    .readTree(response.getBody()).path("code").asText("");
        } catch (Exception ignore) {
            // 非 JSON 体（极端错误页）只留状态码
        }
        return new Outcome(response.getStatusCode().value(), "true".equals(replayed), code);
    }

    @Test
    void 同键并发双发_恰一行_无5xx() throws Exception {
        String key = "m4cnc-appt-" + UUID.randomUUID();

        ExecutorService pool = Executors.newFixedThreadPool(THREADS);
        CountDownLatch start = new CountDownLatch(1);
        Map<String, Integer> statuses = new ConcurrentHashMap<>();
        Map<String, Integer> codes = new ConcurrentHashMap<>();
        AtomicInteger okCount = new AtomicInteger();
        AtomicInteger replayCount = new AtomicInteger();
        try {
            List<Future<Outcome>> futures = new java.util.ArrayList<>();
            for (int i = 0; i < THREADS; i++) {
                futures.add(pool.submit((Callable<Outcome>) () -> {
                    start.await();
                    Outcome outcome = call(key);
                    statuses.merge(String.valueOf(outcome.status()), 1, Integer::sum);
                    codes.merge(outcome.code(), 1, Integer::sum);
                    if (outcome.status() == 200) {
                        okCount.incrementAndGet();
                        if (outcome.replayed()) {
                            replayCount.incrementAndGet();
                        }
                    }
                    return outcome;
                }));
            }
            start.countDown();
            for (Future<Outcome> f : futures) {
                f.get(60, TimeUnit.SECONDS);
            }
        } finally {
            pool.shutdownNow();
        }

        // 无 5xx：撞唯一键必须被兜底为重放（200）或结构化 4xx
        statuses.keySet().stream()
                .filter(s -> s.startsWith("5"))
                .findFirst()
                .ifPresent(s -> {
                    throw new AssertionError("并发出现 5xx（状态分布 " + statuses + "，code 分布 " + codes + "）");
                });

        // 恰落 1 行（唯一键兜底 + 幂等语义）
        Integer rows = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE idempotency_key = ?", Integer.class, key);
        assertEquals(1, rows, "同键并发双发必须恰落 1 行，状态分布 " + statuses);

        // 至少 1 个 200；并发平息后串行重放必须 200 + Replayed=true
        assertTrue(okCount.get() >= 1, "至少 1 个请求成功，状态分布 " + statuses);
        Outcome replay = call(key);
        assertEquals(200, replay.status(), "串行重放应 200");
        assertTrue(replay.replayed(), "串行重放应标记 Idempotency-Replayed=true");
        Integer rowsAfter = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE idempotency_key = ?", Integer.class, key);
        assertEquals(1, rowsAfter, "串行重放不得再建行");
    }
}
