package com.wechar.biz;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.output.MigrateResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * M4.5 迁移回滚演练（docs/v4/08B §M4「迁移回滚演练」，H2 MySQL 兼容模式，不依赖真实 MySQL）：
 *  阶段1 空库恢复点：spring.flyway.target=5 语义 → 只迁 V1~V5（audit_events 尚不存在）；
 *  阶段2 恢复点续迁：同一库补跑 V6~V8（迁移只前进不回头，audit_events / 前端字段 / 扩展资料出现）；
 *  阶段3 幂等重跑：同一库第三次 migrate → migrationsExecuted == 0（V1~V8 均不重复执行）。
 * 结论口径：Flyway Community 无 undo——回滚 = 回到恢复点（target=N）重建/续迁，
 * 生产预案与证据见 backend/deploy/run/m4-m-side-2026-10-16/。
 * 三阶段共用同一物理库文件，模拟真实库上的演进轨迹。
 */
class M4MigrationDrillTest {

    @TempDir
    Path dir;

    /** audit_events 是否存在（回滚/续迁的物理证据）。 */
    private boolean auditTableExists(String url) throws Exception {
        return tableExists(url, "AUDIT_EVENTS");
    }

    private boolean tableExists(String url, String table) throws Exception {
        try (Connection conn = DriverManager.getConnection(url, "sa", "");
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT COUNT(*) FROM information_schema.tables "
                             + "WHERE table_name = '" + table + "'")) {
            rs.next();
            return rs.getInt(1) > 0;
        }
    }

    private boolean columnExists(String url, String table, String column) throws Exception {
        try (Connection conn = DriverManager.getConnection(url, "sa", "");
             Statement st = conn.createStatement();
             ResultSet rs = st.executeQuery(
                     "SELECT COUNT(*) FROM information_schema.columns "
                             + "WHERE table_name = '" + table + "' AND column_name = '" + column + "'")) {
            rs.next();
            return rs.getInt(1) > 0;
        }
    }

    @Test
    void 空库恢复点_续迁V6_幂等重跑() throws Exception {
        // 与全部 Spring 测试上下文同参：H2 MySQL 兼容模式（V1~V6 为 MySQL 方言）
        String url = "jdbc:h2:file:" + dir.resolve("drill").toAbsolutePath().toString().replace('\\', '/')
                + ";MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE";

        // 阶段1 空库 → 恢复点 V5（等价 spring.flyway.target=5）
        MigrateResult toV5 = Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db/migration")
                .target("5")
                .load()
                .migrate();
        assertEquals(5, toV5.migrationsExecuted, "空库应恰好执行 V1~V5 五条迁移");
        assertFalse(auditTableExists(url), "恢复点 V5：audit_events（V6）应不存在");

        // 阶段2 恢复点续迁：同库补跑恢复点之后的全部迁移（当前 V6 审计 + V7 前端字段 + V8 扩展资料）。
        // ⚠️ 期望条数**动态取自实际待迁集**，不再写死（2026-10-18：V8 落地后此处仍写 2 → 全套测试转红；
        //    写死会随每次加迁移再烂一次）。断言仍是"恰好等于待迁条数"，没有放宽。
        Flyway flyway = Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db/migration")
                .load();
        int pendingAfterV5 = flyway.info().pending().length;
        assertTrue(pendingAfterV5 >= 2, "恢复点之后至少应有 V6/V7 两条待迁，实际 " + pendingAfterV5);

        MigrateResult toLatest = flyway.migrate();
        assertEquals(pendingAfterV5, toLatest.migrationsExecuted,
                "恢复点续迁应恰好补跑恢复点之后的全部迁移（当前为 V6/V7/V8/V9 四条）");
        assertTrue(auditTableExists(url), "续迁后 audit_events 应存在");
        assertTrue(columnExists(url, "CONTENTS", "CONTENT_TYPE"), "续迁后 contents.content_type 应存在");
        assertTrue(columnExists(url, "DEPARTMENTS", "FLOOR"), "续迁后 departments.floor 应存在");
        assertTrue(tableExists(url, "HOME_BLOCK_CONFIG"), "续迁后 home_block_config 应存在");
        assertTrue(tableExists(url, "USER_EXTENDED"), "续迁后 user_extended（V8）应存在");
        assertTrue(tableExists(url, "HEALTH_RECORD_ATTACHMENTS"),
                "续迁后 health_record_attachments（V9 附件）应存在");

        // 阶段3 幂等重跑：第三次 migrate 零执行
        MigrateResult rerun = Flyway.configure()
                .dataSource(url, "sa", "")
                .locations("classpath:db/migration")
                .load()
                .migrate();
        assertEquals(0, rerun.migrationsExecuted, "幂等重跑不应执行任何迁移");
        assertTrue(auditTableExists(url), "幂等重跑后状态不变");
    }
}
