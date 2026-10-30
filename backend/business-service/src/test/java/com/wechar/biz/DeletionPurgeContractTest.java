package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;

import com.wechar.biz.deletion.DeletionPurgeService;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 注销冷静期到期账号物理清除契约测试（N10 收尾，2026-10-23）。
 *
 * 覆盖 DeletionPurgeService / DeletionPurgeRepository（@Scheduled 任务的动作本体）：
 *  1. 未到期（deletion_effective_at &gt; now）的 DELETION_PENDING 用户不被选中；
 *  2. 到期用户：全部关联业务数据物理删除 + users 主行匿名化至 DELETED 终态
 *     （openid 改写、手机号/姓名/头像清空），deletion_requests 等法定保留例外不被动；
 *  3. 重复清除幂等（已 DELETED 用户再次执行不抛异常、不产生新副作用）。
 *
 * 数据：test-m1-seed.sql（u-dev-user-1）；H2（MODE=MySQL）内存库。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:mpurge;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
class DeletionPurgeContractTest {

    private static final String USER = "u-dev-user-1";

    @Autowired
    private DeletionPurgeService purgeService;

    @Autowired
    private JdbcTemplate jdbc;

    /** 方法间隔离：清空本类用例可能触碰的表（seed 的 user_profiles 保留用于断言其被清除）。 */
    @BeforeEach
    void cleanUp() {
        jdbc.update("DELETE FROM messages WHERE user_id = ?", USER);
        jdbc.update("DELETE FROM consents WHERE user_id = ?", USER);
        jdbc.update("DELETE FROM user_preferences WHERE user_id = ?", USER);
        jdbc.update("DELETE FROM auth_sessions WHERE user_id = ?", USER);
        jdbc.update("DELETE FROM health_records WHERE user_id = ?", USER);
        jdbc.update("DELETE FROM appointment_status_events WHERE appointment_id IN "
                + "(SELECT id FROM appointments WHERE user_id = ?)", USER);
        jdbc.update("DELETE FROM appointments WHERE user_id = ?", USER);
        jdbc.update("DELETE FROM deletion_requests WHERE user_id = ?", USER);
        // users 复位（用例间互不影响；seed 的 user_profiles 行保留）
        jdbc.update("UPDATE users SET status = 'ACTIVE', wechat_openid = 'dev-openid-1', "
                + "phone_cipher = NULL, phone_hash = 'dev-phone-hash', phone_bound = 0, "
                + "display_name = '开发者一号', avatar_key = NULL, login_consent_version = 'v1', "
                + "deletion_requested_at = NULL, deletion_effective_at = NULL, version = version + 1 "
                + "WHERE id = ?", USER);
    }

    /** 把 u-dev-user-1 置为注销冷静期状态（软删前置条件，模拟 AccountService.deleteAccount 之后）。 */
    private void markDeletionPending(Instant effectiveAt) {
        jdbc.update(
                "UPDATE users SET status = 'DELETION_PENDING', deletion_requested_at = ?, "
                        + "deletion_effective_at = ?, version = version + 1 WHERE id = ?",
                Timestamp.from(effectiveAt.minusSeconds(86400 * 30)), Timestamp.from(effectiveAt), USER);
    }

    private void seedSensitiveData() {
        Instant now = Instant.parse("2026-10-23T03:00:00Z");
        jdbc.update("INSERT INTO messages (id, user_id, type, title, body, created_at) "
                + "VALUES ('pg-msg-1', ?, 'SYSTEM', 't', 'b', ?)", USER, Timestamp.from(now));
        jdbc.update("INSERT INTO consents (id, user_id, purpose, policy_version, status, created_at) "
                + "VALUES ('pg-consent-1', ?, 'PRIVACY', 'v1', 'GRANTED', ?)", USER, Timestamp.from(now));
        jdbc.update("INSERT INTO user_preferences (user_id, locale, theme_mode, font_scale, version, created_at) "
                + "VALUES (?, 'zh-CN', 'SYSTEM', 'STANDARD', 1, ?)", USER, Timestamp.from(now));
        jdbc.update("INSERT INTO auth_sessions (id, user_id, access_token_hash, refresh_token_hash, "
                + "access_expires_at, refresh_expires_at, created_at) "
                + "VALUES ('pg-sess-1', ?, ?, ?, ?, ?, ?)",
                USER, "a".repeat(64), "b".repeat(64),
                Timestamp.from(now.plusSeconds(3600)), Timestamp.from(now.plusSeconds(86400)),
                Timestamp.from(now));
        jdbc.update("INSERT INTO health_records (id, user_id, category, title, recorded_at, version, created_at) "
                + "VALUES ('pg-hr-1', ?, 'REPORT', 't', ?, 1, ?)", USER, Timestamp.from(now), Timestamp.from(now));
        jdbc.update("INSERT INTO appointments (id, user_id, family_member_id, slot_id, doctor_id, department_id, "
                + "patient_name, status, idempotency_key, request_digest, version, created_at) "
                + "VALUES ('pg-ap-1', ?, NULL, 'slot-future-1', 'doc-gastro-1', 'dep-gastro', '张', 'PENDING', "
                + "'pg-ap-key-1', 'pg-ap-digest', 1, ?)",
                USER, Timestamp.from(now));
        jdbc.update("INSERT INTO appointment_status_events (id, appointment_id, from_status, to_status, "
                + "operator_user_id, version_after, server_time, created_at) "
                + "VALUES ('pg-evt-1', 'pg-ap-1', 'PENDING', 'PENDING', ?, 2, ?, ?)",
                USER, Timestamp.from(now), Timestamp.from(now));
        // 法定保留例外：注销申请记录（承诺保留 3 年，证明已履行删除义务）
        jdbc.update("INSERT INTO deletion_requests (id, user_id, scope_json, status, reason, "
                + "idempotency_key, request_digest, created_at) "
                + "VALUES ('pg-delreq-1', ?, '{}', 'RECEIVED', NULL, 'pg-key-1', 'pg-digest', ?)",
                USER, Timestamp.from(now));
    }

    private long count(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table, Long.class);
    }

    /** 按用户维度计数（seed 含其它用户数据，全表计数会误伤断言）。 */
    private long countByUser(String table) {
        return jdbc.queryForObject("SELECT COUNT(*) FROM " + table + " WHERE user_id = ?", Long.class, USER);
    }

    /** appointment_status_events 无 user_id 列，经 appointments 归属计数。 */
    private long countEventsByUser() {
        return jdbc.queryForObject(
                "SELECT COUNT(*) FROM appointment_status_events e "
                        + "JOIN appointments a ON a.id = e.appointment_id WHERE a.user_id = ?",
                Long.class, USER);
    }

    @Test
    void 未到期用户_不被选中() {
        // 冷静期尚未届满（effective_at 在未来）
        markDeletionPending(Instant.now().plusSeconds(86400));
        List<String> due = purgeService.findDueUserIds(50);
        assertThat(due).doesNotContain(USER);

        // 届满后 → 进入待清除清单
        markDeletionPending(Instant.now().minusSeconds(1));
        due = purgeService.findDueUserIds(50);
        assertThat(due).contains(USER);
    }

    @Test
    void 到期用户_业务数据物理清除_主行匿名化_保留例外不动() {
        markDeletionPending(Instant.now().minusSeconds(1));
        seedSensitiveData();

        boolean purged = purgeService.purgeOne(USER);
        assertThat(purged).isTrue();

        // 关联业务数据全部物理删除（按该用户维度；seed 中其它用户数据不受影响）
        assertThat(countByUser("auth_sessions")).isZero();
        assertThat(countByUser("consents")).isZero();
        assertThat(countByUser("user_profiles")).isZero();
        assertThat(countByUser("user_preferences")).isZero();
        assertThat(countByUser("health_records")).isZero();
        assertThat(countByUser("messages")).isZero();
        assertThat(countByUser("appointments")).isZero();
        assertThat(countEventsByUser()).isZero();

        // users 主行匿名化至终态：身份字段全部清空、openid 改写为 deleted-<id>（不破坏唯一键）
        var row = jdbc.queryForMap("SELECT status, display_name, wechat_openid, phone_hash, phone_bound "
                + "FROM users WHERE id = ?", USER);
        assertThat(row.get("status")).isEqualTo("DELETED");
        assertThat(row.get("display_name")).isEqualTo("[已注销]");
        assertThat(row.get("wechat_openid")).isEqualTo("deleted-" + USER);
        assertThat(row.get("phone_hash")).isNull();
        assertThat(((Number) row.get("phone_bound")).intValue()).isZero();

        // 法定/审计保留例外不被动
        assertThat(countByUser("deletion_requests")).isEqualTo(1);
    }

    @Test
    void 已清除用户_重复执行_幂等不抛异常() {
        markDeletionPending(Instant.now().minusSeconds(1));
        seedSensitiveData();
        assertThat(purgeService.purgeOne(USER)).isTrue();

        // 已 DELETED：再次清除不抛异常，且不产生新副作用（匿名化条件 status='DELETION_PENDING' 不命中）
        assertThat(purgeService.purgeOne(USER)).isFalse();
        assertThat(countByUser("messages")).isZero();
    }
}
