package com.wechar.biz.patient;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** health_record_attachments 数据访问（V9）。附件行与文件一一对应；删除档案时行级联清理。 */
@Component
public class AttachmentRepository {

    private final JdbcTemplate jdbc;

    public AttachmentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record AttachmentRow(String id, String recordId, String userId, String objectKey,
                                String fileName, String mime, long size, String sha256,
                                Instant createdAt) {
    }

    private static final String COLS = "id, record_id, user_id, object_key, file_name, mime, size, "
            + "sha256, created_at";

    private static AttachmentRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp created = rs.getTimestamp("created_at");
        return new AttachmentRow(rs.getString("id"), rs.getString("record_id"), rs.getString("user_id"),
                rs.getString("object_key"), rs.getString("file_name"), rs.getString("mime"),
                rs.getLong("size"), rs.getString("sha256"),
                created == null ? null : created.toInstant());
    }

    public List<AttachmentRow> listByRecord(String recordId) {
        return jdbc.query("SELECT " + COLS + " FROM health_record_attachments WHERE record_id = ? "
                        + "ORDER BY created_at DESC, id DESC",
                AttachmentRepository::map, recordId);
    }

    public Optional<AttachmentRow> findById(String recordId, String attachmentId) {
        return jdbc.query("SELECT " + COLS + " FROM health_record_attachments "
                        + "WHERE id = ? AND record_id = ?",
                AttachmentRepository::map, attachmentId, recordId).stream().findFirst();
    }

    public void insert(AttachmentRow row) {
        jdbc.update("INSERT INTO health_record_attachments (id, record_id, user_id, object_key, "
                        + "file_name, mime, size, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                row.id(), row.recordId(), row.userId(), row.objectKey(), row.fileName(),
                row.mime(), row.size(), row.sha256(), Timestamp.from(row.createdAt()));
    }

    public boolean delete(String recordId, String attachmentId) {
        return jdbc.update("DELETE FROM health_record_attachments WHERE id = ? AND record_id = ?",
                attachmentId, recordId) == 1;
    }
}
