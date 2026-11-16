package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * REQ-14（V1.20 HIS 受限接入）契约测试 · 开关关闭路径。
 *
 * <p>不变量：
 * <ul>
 *   <li>{@code app.his.enabled} 默认 false —— 不触达任何外部系统；</li>
 *   <li>落库 {@code booking_source=LOCAL_DEMO}、{@code his_order_no} 为 NULL（不伪造单号）；</li>
 *   <li>响应下发 bookingSource，且不带 hisOrderNo（NON_NULL 省略）。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:his-demo-off;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
class HisBookingLocalDemoContractTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void 开关关闭时按本地演示预约落库且不产生HIS单号() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-User-Id", "dev-user-1");
        headers.set("Idempotency-Key", "his-off-key-0001");

        ResponseEntity<String> response = rest.postForEntity("/api/v1/appointments",
                new HttpEntity<>("{\"slotId\":\"slot-future-1\",\"patientName\":\"演示患者\"}", headers),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        String body = response.getBody();
        // 来源必须显式下发 LOCAL_DEMO（页面据此标「演示预约」）
        assertEquals(true, body != null && body.contains("\"bookingSource\":\"LOCAL_DEMO\""),
                "响应应包含 bookingSource=LOCAL_DEMO，实际: " + body);
        // 从未对接 HIS，不得凭空造一个 hisOrderNo
        assertEquals(false, body != null && body.contains("\"hisOrderNo\""),
                "LOCAL_DEMO 不应下发 hisOrderNo，实际: " + body);

        String appointmentId = jdbc.queryForObject(
                "SELECT id FROM appointments WHERE user_id = ? AND idempotency_key = ?",
                String.class, "u-dev-user-1", "his-off-key-0001");
        assertEquals("LOCAL_DEMO", jdbc.queryForObject(
                "SELECT booking_source FROM appointments WHERE id = ?", String.class, appointmentId));
        assertNull(jdbc.queryForObject(
                "SELECT his_order_no FROM appointments WHERE id = ?", String.class, appointmentId));
    }
}
