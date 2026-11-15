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
 *  - POST /api/v1/dev/slots/reset  → 回补未来 14 天上午/下午多档号源（每档 10 号，扣已约）
 */
@RestController
@RequestMapping("/api/v1/dev")
@Profile("dev")
public class DevAdminController {

    /** 一键重置后每档的空余号源数（演示口径；实际按「容量 - 有效预约数」回补）。 */
    private static final int RESET_REMAINING = 10;

    /**
     * 可预约时段（北京时间，每档 30 分钟）：上午 6 档 + 下午 6 档。
     * 2026-11-15：原来每天只有 09:00 / 14:00 两档，用户可选时间太少；
     * 这里扩到 12 档并**上下午各半**，同时把「上午/下午」写进 id 便于排查。
     */
    private static final String[][] SLOT_TIMES = {
            {"08:00", "08:30"}, {"08:30", "09:00"}, {"09:00", "09:30"},
            {"09:30", "10:00"}, {"10:00", "10:30"}, {"10:30", "11:00"},
            {"14:00", "14:30"}, {"14:30", "15:00"}, {"15:00", "15:30"},
            {"15:30", "16:00"}, {"16:00", "16:30"}, {"16:30", "17:00"}
    };

    /** 补建天数（与前端 7 天日期条相比留出余量，深链约后几天也有号） */
    private static final int SEED_DAYS = 14;

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

    /** 一键重置：关闭过期/旧版两档号源 + 补建未来 14 天上午/下午 12 档 + 按已约数回补余号。 */
    @PostMapping("/slots/reset")
    public Envelope<Map<String, Object>> resetSlots() {
        // 1) 关闭已过期的号源（避免 hasAvailableSlot 误判为可预约）
        int closed = jdbc.update(
                "UPDATE doctor_slots SET status='CLOSED', updated_at=CURRENT_TIMESTAMP(3) " +
                "WHERE status='OPEN' AND start_time < NOW()");
        // 2) 旧版每天只有 09:00(-am) / 14:00(-pm) 两档，与新档 09:00/14:00 会同刻重复：
        //    未来的旧档一律下线。只改 status 不删除 —— appointments.slot_id 有外键，
        //    历史预约仍要能查到这条号源。
        int legacy = jdbc.update(
                "UPDATE doctor_slots SET status='CLOSED', updated_at=CURRENT_TIMESTAMP(3) " +
                "WHERE status='OPEN' AND start_time >= NOW() AND (id LIKE '%-am' OR id LIKE '%-pm')");
        // 3) 补建未来 14 天 × 12 档（幂等：ON DUPLICATE KEY UPDATE；remaining 留给第 4 步按预约算）
        int seeded = 0;
        for (String[] t : SLOT_TIMES) {
            seeded += jdbc.update(slotInsertSql(t[0], t[1]));
        }
        // 4) 余号回补 = 容量 − 有效预约数（PENDING/CONFIRMED）。
        //    原实现无条件刷 20，用户已约的号会被"回血"，同档可超卖；这里按真实占用算。
        int updated = jdbc.update("""
                UPDATE doctor_slots s
                SET s.remaining = GREATEST(s.capacity - (
                        SELECT COUNT(*) FROM appointments a
                        WHERE a.slot_id = s.id AND a.status IN ('PENDING','CONFIRMED')), 0),
                    s.updated_at = CURRENT_TIMESTAMP(3)
                WHERE s.status = 'OPEN' AND s.start_time >= NOW()
                """);
        return Envelope.ok(RequestIds.current(), Map.of(
                "closedExpired", closed,
                "legacyClosed", legacy,
                "seededRows", seeded,
                "resetSlots", updated,
                "remainingEach", RESET_REMAINING,
                "slotTimes", SLOT_TIMES.length,
                "message", "已关闭 " + closed + " 条过期号源、" + legacy + " 条旧版两档号源；"
                        + "补建未来 " + SEED_DAYS + " 天 × 每天 " + SLOT_TIMES.length
                        + " 档（上午 6 + 下午 6，每档 " + RESET_REMAINING + " 号），回补 " + updated + " 条 OPEN 号源余号"));
    }

    /**
     * 单档号源补建 SQL（未来 {@link #SEED_DAYS} 天 × 全部 ACTIVE 医生）。
     * ⚠️ 库内 DATETIME 以 UTC 存储（连接串 forceConnectionTimeZoneToSession=true），
     *    配置表写的是北京时间 → 必须 -8 HOUR，否则前端按设备本地时区一转换就整体偏 8 小时。
     */
    private String slotInsertSql(String startHm, String endHm) {
        String suffix = startHm.replace(":", "");
        StringBuilder days = new StringBuilder();
        for (int i = 0; i < SEED_DAYS; i++) {
            if (i > 0) days.append(" UNION ");
            days.append("SELECT ").append(i).append(" n");
        }
        return "INSERT INTO doctor_slots (id, doctor_id, start_time, end_time, capacity, remaining, fee, currency, status) "
                + "SELECT CONCAT('slot-', d.id, '-', DATE_FORMAT(day.d, '%Y%m%d'), '-" + suffix + "'), d.id, "
                + "TIMESTAMP(day.d, '" + startHm + ":00') - INTERVAL 8 HOUR, "
                + "TIMESTAMP(day.d, '" + endHm + ":00') - INTERVAL 8 HOUR, "
                + RESET_REMAINING + ", " + RESET_REMAINING + ", 25.00, 'CNY', 'OPEN' "
                + "FROM doctors d, (SELECT CURDATE() + INTERVAL n DAY AS d FROM (" + days + ") nums) day "
                + "ON DUPLICATE KEY UPDATE capacity=VALUES(capacity), status='OPEN', updated_at=CURRENT_TIMESTAMP(3)";
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
