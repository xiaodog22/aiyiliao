package com.wechar.biz;

import static org.assertj.core.api.Assertions.assertThat;

import com.wechar.biz.auth.AuthSessionCleanupTask;
import com.wechar.biz.common.AuthSessionStore;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;

/**
 * 过期会话物理清除契约测试（PERF-06，2026-11-01）。
 *
 * 背景：全仓原本唯一一处 DELETE FROM auth_sessions 只在账号注销时触发，没有任何按过期时间的清理
 * → 表只增不删（2026-11-01 实测全表 369 行中 286 行已彻底过期）。
 *
 * 覆盖 AuthSessionStore.deleteRefreshExpiredBefore / AuthSessionCleanupTask：
 *  1. 判据是 **refresh_expires_at** 而非 access_expires_at —— access 过期但 refresh 可轮换的行必须保留，
 *     否则用户在 7 天续期窗口内被强制登出；
 *  2. cutoff 留 GRACE_HOURS 宽限：刚过期（宽限期内）的行不删，防多实例时钟漂移误删；
 *  3. 仍有效的行永不删；
 *  4. 重复执行幂等（第二次 0 行，不抛异常）。
 *
 * 数据：本测试自建 3 条会话行（不依赖 seed），H2（MODE=MySQL）内存库。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:msessclean;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=always",
        "spring.sql.init.encoding=UTF-8",
        "spring.sql.init.data-locations=classpath:db/test-m1-seed.sql"
})
class AuthSessionCleanupTest {

    private static final String USER = "u-dev-user-1";
    /** 远超宽限期的过期时长：确定会被删。 */
    private static final long LONG_EXPIRED_DAYS = 30;
    /** 宽限期内的过期时长：确定会被保留（GRACE_HOURS = 24）。 */
    private static final long GRACE_WINDOW_HOURS = 2;

    @Autowired
    private AuthSessionStore store;

    @Autowired
    private AuthSessionCleanupTask task;

    @Autowired
    private JdbcTemplate jdbc;

    @BeforeEach
    void seedSessions() {
        jdbc.update("DELETE FROM auth_sessions WHERE user_id = ?", USER);
        insert("s-long-expired", LONG_EXPIRED_DAYS * 24);   // 该行 refresh 已于 30 天前过期
        insert("s-in-grace", GRACE_WINDOW_HOURS);           // 该行 refresh 于 2 小时前过期（在 24h 宽限内）
        insert("s-valid", -(24 * 7));                       // 该行 refresh 还有 7 天有效期
    }

    /**
     * 插一条会话。refreshExpiredHoursAgo 语义：正数 = 多少小时**前**已过期，负数 = 还有多少小时**到期**。
     * access 一律设成 1 小时前过期 —— 用来验证判据只认 refresh、不认 access。
     */
    private void insert(String id, long refreshExpiredHoursAgo) {
        Instant now = Instant.now();
        Instant refreshExp = now.minus(refreshExpiredHoursAgo, ChronoUnit.HOURS);
        Instant accessExp = now.minus(1, ChronoUnit.HOURS);
        // token 哈希列是 char(64) UNIQUE：用 id 派生，避免多行撞唯一键
        String seed = String.format("%-64s", id).replace(' ', 'x');
        jdbc.update("INSERT INTO auth_sessions (id, user_id, access_token_hash, refresh_token_hash, "
                        + "access_expires_at, refresh_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                id, USER, seed, new StringBuilder(seed).reverse().toString(),
                Timestamp.from(accessExp), Timestamp.from(refreshExp), Timestamp.from(now));
    }

    private long count(String id) {
        Integer n = jdbc.queryForObject("SELECT COUNT(*) FROM auth_sessions WHERE id = ?", Integer.class, id);
        return n == null ? 0 : n;
    }

    @Test
    void 只删远超宽限期的过期会话() {
        int deleted = store.deleteRefreshExpiredBefore(Instant.now().minus(24, ChronoUnit.HOURS), 2000);

        assertThat(count("s-long-expired")).as("30 天前过期的会话应被物理删除").isZero();
        assertThat(count("s-in-grace")).as("宽限期（24h）内刚过期的会话必须保留").isEqualTo(1);
        assertThat(count("s-valid")).as("仍有效的会话必须保留").isEqualTo(1);
        assertThat(deleted).as("本批实删行数应与 long-expired 一致（幂等删除条件，异常残留为 0）").isGreaterThanOrEqualTo(1);
    }

    @Test
    void access过期但refresh可续期的行不得删除() {
        // seedSessions 里三条行的 access_expires_at 全部已过期 → 若实现误用 access 判据会全删
        store.deleteRefreshExpiredBefore(Instant.now().minus(24, ChronoUnit.HOURS), 2000);

        assertThat(count("s-valid")).as("access 过期但 refresh 未过期 = 仍可续期，删了就是强制登出").isEqualTo(1);
        assertThat(count("s-in-grace")).as("同理，宽限期内也不得因 access 过期而删").isEqualTo(1);
    }

    @Test
    void 重复执行幂等且不抛异常() {
        Instant cutoff = Instant.now().minus(24, ChronoUnit.HOURS);
        store.deleteRefreshExpiredBefore(cutoff, 2000);
        int second = store.deleteRefreshExpiredBefore(cutoff, 2000);

        assertThat(second).as("同条件二次执行应删 0 行").isZero();
        assertThat(count("s-valid")).isEqualTo(1);
    }

    @Test
    void 定时任务执行后不误伤有效会话() {
        task.purgeExpiredSessions();

        assertThat(count("s-long-expired")).as("任务必须清掉 Long-expired").isZero();
        assertThat(count("s-valid")).as("任务必须保留有效会话").isEqualTo(1);
        assertThat(count("s-in-grace")).as("任务必须保留宽限期内会话").isEqualTo(1);
    }
}
