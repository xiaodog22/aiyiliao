package com.wechar.biz.dev;

import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import org.springframework.context.annotation.Profile;
import org.springframework.core.io.ClassPathResource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.util.StreamUtils;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;

/**
 * dev 档演示管理端点（2026-10-24）。
 *
 * ⚠️ 仅 dev profile 注册（生产环境 Bean 不装配，路径直接 404）。
 * 用途：演示前一键把「约满」号源重置为「空余 20」，避免演示几轮后前端全灰。
 * 配套页面：src/main/resources/static/dev-admin.html（浏览器打开 /dev-admin.html）。
 *
 * 端点（已在 AuthInterceptor 白名单，dev 档免登录）：
 *  - GET  /api/v1/dev/slots/status → 按医生聚合的当前剩余号源状态
 *  - POST /api/v1/dev/slots/reset  → 所有 OPEN 号源 capacity/remaining 重置为 20
 */
@RestController
@RequestMapping("/api/v1/dev")
@Profile("dev")
public class DevAdminController {

    /** 一键重置后的空余号源数（演示口径）。 */
    private static final int RESET_REMAINING = 20;

    private final JdbcTemplate jdbc;

    public DevAdminController(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 医生号源状态快照：按医生聚合 OPEN 号源数与剩余合计。 */
    @GetMapping("/slots/status")
    public Envelope<Map<String, Object>> slotStatus() {
        List<Map<String, Object>> rows = jdbc.queryForList("""
                SELECT d.id AS doctorId, d.name AS doctorName, d.title AS title,
                       dep.name AS departmentName,
                       COUNT(s.id) AS openSlots,
                       COALESCE(SUM(s.remaining), 0) AS totalRemaining
                FROM doctors d
                LEFT JOIN departments dep ON dep.id = d.department_id
                LEFT JOIN doctor_slots s ON s.doctor_id = d.id AND s.status = 'OPEN'
                WHERE d.status = 'ACTIVE'
                GROUP BY d.id, d.name, d.title, dep.name
                ORDER BY dep.sort_order, d.id
                """);
        long fullCount = rows.stream()
                .filter(r -> ((Number) r.getOrDefault("totalRemaining", 0)).intValue() <= 0)
                .count();
        return Envelope.ok(RequestIds.current(), Map.of(
                "doctors", rows,
                "fullDoctors", fullCount,
                "resetRemaining", RESET_REMAINING));
    }

    /** 一键重置：关闭过期号源 + 补建未来 7 天 AM/PM 号源 + 现有 OPEN 号源 remaining=20。 */
    @PostMapping("/slots/reset")
    public Envelope<Map<String, Object>> resetSlots() {
        // 1) 关闭已过期的号源（避免 hasAvailableSlot 误判为可预约）
        int closed = jdbc.update(
                "UPDATE doctor_slots SET status='CLOSED', updated_at=CURRENT_TIMESTAMP(3) " +
                "WHERE status='OPEN' AND start_time < NOW()");
        // 2) 补建未来 7 天 AM/PM 号源（幂等：ON DUPLICATE KEY UPDATE）
        jdbc.update("""
                INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
                SELECT CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-am'),
                       d.id, TIMESTAMP(day.d, '09:00:00'), TIMESTAMP(day.d, '09:30:00'),
                       20, 20, 25.00, 'CNY', 'OPEN'
                FROM doctors d,
                     (SELECT CURDATE() + INTERVAL n DAY AS d FROM
                      (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
                       UNION SELECT 5 UNION SELECT 6) nums) day
                ON DUPLICATE KEY UPDATE capacity=20, remaining=20, status='OPEN', updated_at=CURRENT_TIMESTAMP(3)
                """);
        jdbc.update("""
                INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status)
                SELECT CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-pm'),
                       d.id, TIMESTAMP(day.d, '14:00:00'), TIMESTAMP(day.d, '14:30:00'),
                       20, 20, 25.00, 'CNY', 'OPEN'
                FROM doctors d,
                     (SELECT CURDATE() + INTERVAL n DAY AS d FROM
                      (SELECT 0 n UNION SELECT 1 UNION SELECT 2 UNION SELECT 3 UNION SELECT 4
                       UNION SELECT 5 UNION SELECT 6) nums) day
                ON DUPLICATE KEY UPDATE capacity=20, remaining=20, status='OPEN', updated_at=CURRENT_TIMESTAMP(3)
                """);
        // 3) 现有 OPEN 号源统一 remaining=20
        int updated = jdbc.update(
                "UPDATE doctor_slots SET capacity=20, remaining=20, updated_at=CURRENT_TIMESTAMP(3) WHERE status='OPEN'");
        return Envelope.ok(RequestIds.current(), Map.of(
                "closedExpired", closed,
                "resetSlots", updated,
                "remainingEach", RESET_REMAINING,
                "message", "已关闭 " + closed + " 条过期号源，" + updated + " 条 OPEN 号源重置为空余 " + RESET_REMAINING + "（含补建未来 7 天）"));
    }

    /**
     * 图形化管理页（application.yml 关闭了静态资源映射 add-mappings=false，
     * 故由 Controller 直接吐出 classpath:/static/dev-admin.html）。
     * 浏览器打开 http://localhost:8088/api/v1/dev/admin
     */
    @GetMapping(value = "/admin", produces = MediaType.TEXT_HTML_VALUE + ";charset=UTF-8")
    public ResponseEntity<String> adminPage() throws IOException {
        String html = StreamUtils.copyToString(
                new ClassPathResource("static/dev-admin.html").getInputStream(),
                StandardCharsets.UTF_8);
        return ResponseEntity.ok(html);
    }
}
