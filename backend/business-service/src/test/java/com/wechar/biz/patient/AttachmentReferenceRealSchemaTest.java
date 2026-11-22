package com.wechar.biz.patient;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;

/**
 * B2 阻断项回归：附件孤儿清理的引用查询必须跑在**真实 Flyway schema** 上。
 *
 * <p>原缺陷（D-03/D-04）：
 * <ul>
 *   <li>{@code SELECT COUNT(*) FROM health_reports ...} —— 全仓库没有 health_reports 表，
 *       H2 直接报 Table "HEALTH_REPORTS" not found；</li>
 *   <li>清理任务捕获异常后保留文件 → 所有过期未引用附件永远清理不掉；</li>
 *   <li>原 {@code AttachmentCleanupTaskTest} 用 mock(AttachmentReferenceRepository)，
 *       4/0 全绿也发现不了真实 SQL 错误。</li>
 * </ul>
 *
 * <p>本测试不使用 Repository mock：H2 + 真实迁移建表，直接断言列级引用矩阵与清理结果。
 */
@SpringBootTest(properties = {
        "spring.profiles.active=itest",
        "spring.datasource.url=jdbc:h2:mem:attref;MODE=MySQL;DATABASE_TO_LOWER=TRUE;CASE_INSENSITIVE_IDENTIFIERS=TRUE;DB_CLOSE_DELAY=-1",
        "spring.datasource.username=sa",
        "spring.datasource.password=",
        "phone.key-base64=MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
        "spring.sql.init.mode=never"
})
@Transactional
class AttachmentReferenceRealSchemaTest {

    private static final String SIGN_SECRET = "0123456789abcdef0123456789abcdef";

    @Autowired
    private AttachmentReferenceRepository references;

    @Autowired
    private JdbcTemplate jdbc;

    private String userId;
    private String recordId;

    @BeforeEach
    void seedFixture() {
        userId = "u-attref";
        recordId = "hr-attref";
        jdbc.update("MERGE INTO users (id, wechat_openid, display_name) KEY (id) VALUES (?,?,?)",
                userId, "openid-attref", "附件清理测试");
        jdbc.update("MERGE INTO health_records (id, user_id, category, recorded_at) KEY (id) VALUES (?,?,?,?)",
                recordId, userId, "REPORT", java.sql.Timestamp.valueOf("2026-01-01 00:00:00"));
    }

    @Test
    void 真实schema下不存在的表异常已消除且未引用返回false() {
        // 修复前：health_reports 不存在 → BadSqlGrammarException
        assertThat(references.isReferenced("a".repeat(32) + ".jpg")).isFalse();
    }

    @Test
    void 附件表object_key与preview_object_key任一引用都保留() {
        String objectKey = "b".repeat(32) + ".jpg";
        String previewKey = "c".repeat(32) + ".png";
        insertAttachment("hra-object", objectKey, null);
        insertAttachment("hra-preview", "d".repeat(32) + ".jpg", previewKey);

        assertThat(references.isReferenced(objectKey)).isTrue();
        assertThat(references.isReferenced(previewKey)).isTrue();
    }

    @Test
    void 问诊图片消息与科普封面视频引用同样保留() {
        String messageKey = "e".repeat(32) + ".jpg";
        String coverKey = "f".repeat(32) + ".jpg";
        String videoKey = "1".repeat(32) + ".mp4";
        jdbc.update("INSERT INTO consultations (id, user_id, status, created_at) VALUES (?,?,?,?)",
                "c-attref", userId, "ACTIVE", java.sql.Timestamp.valueOf("2026-01-01 00:00:00"));
        jdbc.update("INSERT INTO consultation_messages "
                        + "(id, consultation_id, user_id, role, content_type, content, created_at) "
                        + "VALUES (?,?,?,?,?,?,?)",
                "m-attref", "c-attref", userId, "USER", "IMAGE_NOTE", messageKey,
                java.sql.Timestamp.valueOf("2026-01-01 00:00:00"));
        jdbc.update("INSERT INTO health_articles "
                        + "(id, title, category, published_at, cover_key, video_key) VALUES (?,?,?,?,?,?)",
                "art-attref", "测试科普", "GUIDE", java.sql.Timestamp.valueOf("2026-01-01 00:00:00"),
                coverKey, videoKey);

        assertThat(references.isReferenced(messageKey)).isTrue();
        assertThat(references.isReferenced(coverKey)).isTrue();
        assertThat(references.isReferenced(videoKey)).isTrue();
    }

    @Test
    void 清理任务使用真实引用查询_只删过期未引用文件(@TempDir Path tempDir) throws Exception {
        Path dir = Files.createDirectories(tempDir.resolve("attachments"));
        AttachmentStorage storage = new AttachmentStorage(tempDir.toString(), SIGN_SECRET,
                900, 10 * 1024 * 1024, 50 * 1024 * 1024, 7200);

        String objectKey = "2".repeat(32) + ".jpg";
        String previewKey = "3".repeat(32) + ".png";
        String orphanKey = "4".repeat(32) + ".jpg";
        String freshKey = "5".repeat(32) + ".jpg";
        insertAttachment("hra-live", objectKey, previewKey);
        touch(dir, objectKey, Instant.now().minus(25, ChronoUnit.HOURS));
        touch(dir, previewKey, Instant.now().minus(25, ChronoUnit.HOURS));
        touch(dir, orphanKey, Instant.now().minus(25, ChronoUnit.HOURS));
        touch(dir, freshKey, Instant.now());

        int deleted = new AttachmentCleanupTask(storage, references, true, 24).cleanup();

        assertThat(deleted).isEqualTo(1);
        assertThat(dir.resolve(objectKey)).exists();
        assertThat(dir.resolve(previewKey)).exists();
        assertThat(dir.resolve(orphanKey)).doesNotExist();
        assertThat(dir.resolve(freshKey)).exists();
    }

    private void insertAttachment(String id, String objectKey, String previewObjectKey) {
        jdbc.update("INSERT INTO health_record_attachments "
                        + "(id, record_id, user_id, object_key, file_name, mime, size, sha256, created_at, preview_object_key) "
                        + "VALUES (?,?,?,?,?,?,?,?,?,?)",
                id, recordId, userId, objectKey, "x.jpg", "image/jpeg", 1L, "0".repeat(64),
                java.sql.Timestamp.valueOf("2026-01-01 00:00:00"), previewObjectKey);
    }

    private static void touch(Path dir, String name, Instant modified) throws Exception {
        Path file = dir.resolve(name);
        Files.writeString(file, "x");
        Files.setLastModifiedTime(file, FileTime.from(modified));
    }
}
