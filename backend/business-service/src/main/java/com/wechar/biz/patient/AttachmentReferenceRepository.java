package com.wechar.biz.patient;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 判断 objectKey 是否仍被业务数据引用（供孤儿附件清理使用，2026-11-22 L2）。
 *
 * <p>引用来源必须与 {@code AttachmentStorage.delete()} 的调用点一致，漏一处就会误删：
 * <ul>
 *   <li>{@code health_record_attachments.object_key}：健康档案附件（主要引用）；</li>
 *   <li>{@code health_record_attachments.preview_object_key}：V27 报告预览图，
 *       与 object_key 同表不同列（⚠️ 不存在 health_reports 表，D-03 缺陷根因）；</li>
 *   <li>{@code consultation_messages.content}（content_type=IMAGE_NOTE）：
 *       问诊图片消息把 objectKey 直接存在 content（见 ConsultationService.toMessageData）；</li>
 *   <li>{@code health_articles.cover_key / video_key}：科普封面与视频复用附件对象键，
 *       只查附件表会把文章素材当孤儿删掉。</li>
 * </ul>
 *
 * <p>不纳入：{@code users.avatar_key}（AvatarStorage 落在 uploads/avatars，清理任务不扫该目录）；
 * {@code resource_asset.resource_key} / {@code departments.icon_key}（打包内静态资源，非上传文件）。
 *
 * <p>默认保守：查询异常向上抛，清理任务整体跳过本轮（宁可不删，不可误删）。
 */
@Component
public class AttachmentReferenceRepository {

    private final JdbcTemplate jdbc;

    public AttachmentReferenceRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public boolean isReferenced(String objectKey) {
        if (objectKey == null || objectKey.isBlank()) {
            return true; // 空 key 不归清理任务处理
        }
        return count("SELECT COUNT(*) FROM health_record_attachments "
                + "WHERE object_key = ? OR preview_object_key = ?", objectKey, objectKey) > 0
                || count("SELECT COUNT(*) FROM consultation_messages "
                        + "WHERE content_type = 'IMAGE_NOTE' AND content = ?", objectKey) > 0
                || count("SELECT COUNT(*) FROM health_articles "
                        + "WHERE cover_key = ? OR video_key = ?", objectKey, objectKey) > 0;
    }

    private int count(String sql, Object... args) {
        Integer n = jdbc.queryForObject(sql, Integer.class, args);
        return n == null ? 0 : n;
    }
}
