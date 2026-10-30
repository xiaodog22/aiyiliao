package com.wechar.biz.message;

import java.sql.ResultSet;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * messages 表数据访问（V21）。
 * 消息只追加不改写（除已读时间戳）；列表按 (user_id, created_at) 倒序（新→旧）。
 */
@Component
public class MessageRepository {

    public record MessageRow(String id, String userId, String type, String title, String body,
                             String refType, String refId, Instant readAt, Instant createdAt) {
    }

    private final JdbcTemplate jdbc;

    public MessageRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    private static MessageRow mapRow(ResultSet rs, int rowNum) throws java.sql.SQLException {
        Timestamp read = rs.getTimestamp("read_at");
        Timestamp created = rs.getTimestamp("created_at");
        return new MessageRow(rs.getString("id"), rs.getString("user_id"), rs.getString("type"),
                rs.getString("title"), rs.getString("body"), rs.getString("ref_type"),
                rs.getString("ref_id"), read == null ? null : read.toInstant(),
                created == null ? null : created.toInstant());
    }

    public void insert(MessageRow row) {
        jdbc.update("INSERT INTO messages (id, user_id, type, title, body, ref_type, ref_id, read_at, created_at) "
                + "VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)",
                row.id(), row.userId(), row.type(), row.title(), row.body(), row.refType(), row.refId(),
                Timestamp.from(row.createdAt()));
    }

    /** 当前用户消息列表（新→旧）；cursor 为 (createdAt, id) 双键，与全局 Cursors 一致。 */
    public List<MessageRow> listByUser(String userId, Instant cursorTime, String cursorId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT id, user_id, type, title, body, ref_type, ref_id, "
                + "read_at, created_at FROM messages WHERE user_id = ?");
        List<Object> args = new java.util.ArrayList<>(List.of(userId));
        if (cursorTime != null) {
            sql.append(" AND (created_at < ? OR (created_at = ? AND id < ?))");
            args.add(Timestamp.from(cursorTime));
            args.add(Timestamp.from(cursorTime));
            args.add(cursorId);
        }
        sql.append(" ORDER BY created_at DESC, id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), MessageRepository::mapRow, args.toArray());
    }

    /** 未读数（read_at IS NULL）；红点唯一数据源。 */
    public int countUnread(String userId) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM messages WHERE user_id = ? AND read_at IS NULL",
                Integer.class, userId);
        return n == null ? 0 : n;
    }

    /** 标记已读（幂等：仅未读行被更新；重复调用返回 false 但不报错）。 */
    public boolean markRead(String userId, String id, Instant now) {
        int updated = jdbc.update("UPDATE messages SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL",
                Timestamp.from(now), id, userId);
        return updated == 1;
    }

    /** 他人消息（越权）一律按不存在处理（不泄露存在性）。 */
    public boolean existsForUser(String userId, String id) {
        Integer n = jdbc.queryForObject(
                "SELECT COUNT(*) FROM messages WHERE id = ? AND user_id = ?",
                Integer.class, id, userId);
        return n != null && n > 0;
    }
}
