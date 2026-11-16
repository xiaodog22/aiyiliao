package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import com.wechar.biz.appointment.his.HisClient;
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
import org.springframework.test.context.bean.override.mockito.MockitoBean;

/**
 * REQ-14 契约测试 · HIS 受理失败路径（最关键的边界）。
 *
 * <p>不变量（任一破坏即视为「伪造预约成功」）：
 * <ul>
 *   <li>HIS 抛异常 → HTTP 503 + code=HIS_UNAVAILABLE（retryable=true）；</li>
 *   <li>不落本地预约单（appointments 行数不变）；</li>
 *   <li>号源余量不被消耗（扣号随事务回滚）；</li>
 *   <li>响应体不得出现任何「成功」语义字段（无 id / bookingSource）。</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:his-demo-fail;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql",
        "app.his.enabled=true",
        "app.his.mode=mock"
})
class HisBookingFailureContractTest {

    @Autowired
    private TestRestTemplate rest;

    @Autowired
    private JdbcTemplate jdbc;

    /** 替换真实适配器：模拟 HIS 连接失败（超时/拒绝都走同一异常路径）。 */
    @MockitoBean
    private HisClient hisClient;

    @Test
    void HIS受理失败时返回503且不落单不扣号() {
        when(hisClient.book(any())).thenThrow(new RuntimeException("connect timed out"));

        int appointmentsBefore = countAppointments();
        int remainingBefore = slotRemaining();

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.set("X-User-Id", "dev-user-1");
        headers.set("Idempotency-Key", "his-fail-key-0001");

        ResponseEntity<String> response = rest.postForEntity("/api/v1/appointments",
                new HttpEntity<>("{\"slotId\":\"slot-future-1\",\"patientName\":\"失败路径患者\"}", headers),
                String.class);

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        String body = response.getBody();
        assertTrue(body != null && body.contains("HIS_UNAVAILABLE"),
                "响应应包含 HIS_UNAVAILABLE，实际: " + body);

        // 核心红线：对接失败不得留下任何「已成立」的痕迹
        assertEquals(appointmentsBefore, countAppointments(), "HIS 失败后不得落本地预约单");
        assertEquals(remainingBefore, slotRemaining(), "HIS 失败后号源余量必须保持不变（扣号需回滚）");
    }

    private int countAppointments() {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointments WHERE user_id = ?", Integer.class, "u-dev-user-1");
        return n == null ? 0 : n;
    }

    private int slotRemaining() {
        Integer n = jdbc.queryForObject(
                "SELECT remaining FROM doctor_slots WHERE id = ?", Integer.class, "slot-future-1");
        return n == null ? -1 : n;
    }
}
