package com.wechar.biz.patient;

import com.wechar.biz.common.AuditLog;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.stream.Stream;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 孤儿附件清理（2026-11-22 敌意审查 L2）。
 *
 * <p>缺陷：两段式上传第一段落盘后若用户放弃建档/问诊，文件永久留在
 * {@code {app.upload.dir}/attachments}，无任何回收机制；单账号可反复上传 50MB 视频
 * 把磁盘打满（配合上传限流前甚至无上限）。
 *
 * <p>清理口径（保守，宁可不删不可误删）：
 * <ol>
 *   <li>只处理服务端生成的白名单文件名（32hex + 允许扩展名），其它文件一概不碰；</li>
 *   <li>只删「最后修改时间早于保留期」的文件（默认 24h，留足用户填表/断点时间）；</li>
 *   <li>只要被 health_record_attachments（object_key / preview_object_key）/
 *       health_articles（cover_key / video_key）/ 问诊 IMAGE_NOTE 任一引用，就保留；
 *       查询异常也保留；</li>
 *   <li>单文件删除失败仅记日志（不记完整路径），不中断整轮；</li>
 *   <li>有删除/失败时写一条 {@code audit_events}，action 内携带 scanned/deleted/failed。</li>
 * </ol>
 * 默认每小时跑一次；{@code app.attachment.cleanup-enabled=false} 或
 * {@code orphan-retention-hours<=0} 可关闭（生产不建议）。
 */
@Component
public class AttachmentCleanupTask {

    private static final Logger log = LoggerFactory.getLogger(AttachmentCleanupTask.class);

    private final AttachmentStorage storage;
    private final AttachmentReferenceRepository references;
    private final boolean enabled;
    private final long retentionHours;
    private final AuditLog auditLog;

    @Autowired
    public AttachmentCleanupTask(
            AttachmentStorage storage,
            AttachmentReferenceRepository references,
            @Value("${app.attachment.cleanup-enabled:true}") boolean enabled,
            @Value("${app.attachment.orphan-retention-hours:24}") long retentionHours,
            AuditLog auditLog) {
        this.storage = storage;
        this.references = references;
        this.enabled = enabled;
        this.retentionHours = retentionHours;
        this.auditLog = auditLog;
    }

    /** 单测用：不写 audit_events。 */
    AttachmentCleanupTask(AttachmentStorage storage, AttachmentReferenceRepository references,
                          boolean enabled, long retentionHours) {
        this(storage, references, enabled, retentionHours, null);
    }

    @Scheduled(fixedDelayString = "${app.attachment.cleanup-interval-ms:3600000}",
            initialDelayString = "${app.attachment.cleanup-initial-delay-ms:60000}")
    public void scheduledCleanup() {
        cleanup();
    }

    /**
     * 执行一轮清理。返回删除文件数（测试可直接调用，不依赖调度器）。
     */
    public int cleanup() {
        if (!enabled || retentionHours <= 0) {
            return 0;
        }
        Path dir = storage.directory();
        if (!Files.isDirectory(dir)) {
            return 0;
        }
        Instant cutoff = Instant.now().minus(retentionHours, ChronoUnit.HOURS);
        int scanned = 0;
        int deleted = 0;
        int failed = 0;
        try (Stream<Path> entries = Files.list(dir)) {
            List<Path> candidates = entries.filter(Files::isRegularFile).toList();
            for (Path file : candidates) {
                String objectKey = file.getFileName().toString();
                if (!AttachmentStorage.isSafeKey(objectKey)) {
                    continue; // 非服务端产物（含攻击者投放的任意文件）不归本任务处理
                }
                scanned++;
                try {
                    if (Files.getLastModifiedTime(file).toInstant().isAfter(cutoff)) {
                        continue; // 保留期内：可能仍在填表/上传中
                    }
                    if (references.isReferenced(objectKey)) {
                        continue;
                    }
                    if (Files.deleteIfExists(file)) {
                        deleted++;
                    }
                } catch (RuntimeException | IOException e) {
                    // 查询失败/删除失败一律保留该文件（保守），下轮再试
                    failed++;
                    log.warn("attachment orphan cleanup skipped key={} reason={}",
                            objectKey, e.getClass().getSimpleName());
                }
            }
        } catch (IOException e) {
            log.warn("attachment orphan cleanup list failed: {}", e.getClass().getSimpleName());
            return 0;
        }
        if (deleted > 0 || failed > 0) {
            log.info("attachment orphan cleanup scanned={} deleted={} failed={} retentionHours={}",
                    scanned, deleted, failed, retentionHours);
            if (auditLog != null) {
                auditLog.record(null,
                        "ATTACHMENT_ORPHAN_CLEANUP scanned=" + scanned
                                + " deleted=" + deleted + " failed=" + failed,
                        "attachment", 200, "cleanup-" + System.currentTimeMillis(), null);
            }
        }
        return deleted;
    }
}
