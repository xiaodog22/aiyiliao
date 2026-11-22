package com.wechar.biz.patient;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.wechar.biz.common.AuditLog;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * L2 孤儿附件清理单元测试（2026-11-22）。
 *
 * <p>复现的缺陷：两段式上传第一段落盘后未挂档/未发消息的附件永久残留，无回收；
 * 清理逻辑必须同时满足「引用保留、保留期保留、非法文件名不碰、查询异常保留」。
 */
class AttachmentCleanupTaskTest {

    private static final Instant OLD = Instant.now().minus(25, ChronoUnit.HOURS);

    @TempDir
    Path tempDir;

    private AttachmentStorage storage;
    private AttachmentReferenceRepository references;

    @BeforeEach
    void setUp() throws Exception {
        storage = new AttachmentStorage(tempDir.toString(), "0123456789abcdef0123456789abcdef",
                900, 10 * 1024 * 1024, 50 * 1024 * 1024, 7200);
        Files.createDirectories(tempDir.resolve("attachments"));
        references = mock(AttachmentReferenceRepository.class);
    }

    @Test
    void 过期孤儿删除_被引用保留_新鲜保留_非法名不碰() throws Exception {
        String referenced = "a".repeat(32) + ".jpg";
        String orphan = "b".repeat(32) + ".jpg";
        String fresh = "c".repeat(32) + ".jpg";
        String illegal = "d".repeat(32) + ".exe";
        touch(referenced, OLD);
        touch(orphan, OLD);
        touch(fresh, Instant.now());
        touch(illegal, OLD);
        when(references.isReferenced(referenced)).thenReturn(true);

        int deleted = new AttachmentCleanupTask(storage, references, true, 24).cleanup();

        assertThat(deleted).isEqualTo(1);
        assertThat(tempDir.resolve("attachments").resolve(orphan)).doesNotExist();
        assertThat(tempDir.resolve("attachments").resolve(referenced)).exists();
        assertThat(tempDir.resolve("attachments").resolve(fresh)).exists();
        assertThat(tempDir.resolve("attachments").resolve(illegal)).exists();
    }

    @Test
    void 引用查询异常时保留文件而不是误删() throws Exception {
        String key = "e".repeat(32) + ".jpg";
        touch(key, OLD);
        when(references.isReferenced(anyString())).thenThrow(new IllegalStateException("db down"));

        int deleted = new AttachmentCleanupTask(storage, references, true, 24).cleanup();

        assertThat(deleted).isZero();
        assertThat(tempDir.resolve("attachments").resolve(key)).exists();
    }

    @Test
    void 关闭清理或保留期非正数时不执行() throws Exception {
        String key = "f".repeat(32) + ".jpg";
        touch(key, OLD);

        assertThat(new AttachmentCleanupTask(storage, references, false, 24).cleanup()).isZero();
        assertThat(new AttachmentCleanupTask(storage, references, true, 0).cleanup()).isZero();
        assertThat(tempDir.resolve("attachments").resolve(key)).exists();
    }

    @Test
    void 清理写审计事件并携带删除计数() throws Exception {
        String key = "1".repeat(32) + ".jpg";
        touch(key, OLD);
        AuditLog auditLog = mock(AuditLog.class);

        int deleted = new AttachmentCleanupTask(storage, references, true, 24, auditLog).cleanup();

        assertThat(deleted).isEqualTo(1);
        verify(auditLog).record(isNull(), contains("deleted=1"), eq("attachment"),
                eq(200), anyString(), isNull());
    }

    private void touch(String objectKey, Instant modified) throws Exception {
        Path file = tempDir.resolve("attachments").resolve(objectKey);
        Files.writeString(file, "x");
        Files.setLastModifiedTime(file, FileTime.from(modified));
    }
}
