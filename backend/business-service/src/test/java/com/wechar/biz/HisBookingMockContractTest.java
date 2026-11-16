package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

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
 * REQ-14 契约测试 · 开关开启（Mock 适配器）路径。
 *
 * <p>不变量：
 * <ul>
 *   <li>落库 {@code booking_source=HIS_MOCK} 且有 {@code HIS-MOCK-*} 业务单号（可追溯到模拟受理）；</li>
 *   <li>响应同时下发 hisOrderNo 与 bookingSource；</li>
 *   <li>单号前缀即「非真实」标识，页面不会误报真实挂号成功。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:his-demo-mock;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        // 唯一的「接 HIS」路径：mock 适配器，仍不产生任何网络调用
        "app.his.enabled=true",
        "app.his.mode=mock"
})
class HisBookingMockContractTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JdbcTemplate jdbc;

    @Test
    void 开启后走Mock受理并落HIS业务单号() {
        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-User-Id", "dev-user-1");
        headers.set("Idempotency-Key", "his-mock-key-0001");

        ResponseEntity<String> response = rest.postForEntity("/api/v1/appointments",
                new HttpEntity<>("{\"slotId\":\"slot-future-1\",\"patientName\":\"模拟受理患者\"}", headers),
                String.class);

        assertEquals(HttpStatus.OK, response.getStatusCode());
        String body = response.getBody();
        assertTrue(body != null && body.contains("\"bookingSource\":\"HIS_MOCK\""),
                "响应应包含 bookingSource=HIS_MOCK，实际: " + body);
        assertTrue(body != null && body.contains("\"hisOrderNo\":\"HIS-MOCK-"),
                "响应应包含 HIS-MOCK-* 单号，实际: " + body);

        String appointmentId = jdbc.queryForObject(
                "SELECT id FROM appointments WHERE user_id = ? AND idempotency_key = ?",
                String.class, "u-dev-user-1", "his-mock-key-0001");
        assertEquals("HIS_MOCK", jdbc.queryForObject(
                "SELECT booking_source FROM appointments WHERE id = ?", String.class, appointmentId));
        String orderNo = jdbc.queryForObject(
                "SELECT his_order_no FROM appointments WHERE id = ?", String.class, appointmentId);
        assertTrue(orderNo != null && orderNo.startsWith("HIS-MOCK-"),
                "his_order_no 应以 HIS-MOCK- 开头，实际: " + orderNo);
    }
}
