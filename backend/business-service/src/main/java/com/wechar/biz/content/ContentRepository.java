package com.wechar.biz.content;

import java.sql.Date;
import java.sql.Timestamp;
import java.time.Instant;
import java.time.LocalDate;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/** contents 表只读访问（V2 新表）。可见性：review_status='APPROVED' 且在有效期内。 */
@Component
public class ContentRepository {

    private final JdbcTemplate jdbc;

    public ContentRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    public record ContentRow(String id, String title, String summary, String category, String body,
                             String source, String reviewer, String coverKey, String reviewStatus,
                             String provenance, String contentType, String coverUrl, String videoUrl,
                             Integer durationSec, Integer readTimeSec,
                             LocalDate effectiveFrom, LocalDate effectiveTo,
                             Instant publishedAt, int readCount) {
    }

    private static ContentRow map(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        Date ef = rs.getDate("effective_from");
        Date et = rs.getDate("effective_to");
        Timestamp pub = rs.getTimestamp("published_at");
        return new ContentRow(
                rs.getString("id"), rs.getString("title"), rs.getString("summary"), rs.getString("category"),
                rs.getString("body"), rs.getString("source"), rs.getString("reviewer"), rs.getString("cover_key"),
                rs.getString("review_status"), rs.getString("provenance"),
                rs.getString("content_type"), rs.getString("cover_url"), rs.getString("video_url"),
                toInt(rs.getObject("duration_sec")), toInt(rs.getObject("read_time_sec")),
                ef == null ? null : ef.toLocalDate(), et == null ? null : et.toLocalDate(),
                pub == null ? null : pub.toInstant(), rs.getInt("read_count"));
    }

    /** 可空 INT：JDBC 驱动返回 Integer/Long 不一，统一按 Number 归一。 */
    private static Integer toInt(Object raw) {
        return raw == null ? null : ((Number) raw).intValue();
    }

    private static final String COLS = "id, title, summary, category, body, source, reviewer, cover_key, "
            + "review_status, provenance, content_type, cover_url, video_url, duration_sec, read_time_sec, "
            + "effective_from, effective_to, published_at, read_count";

    public List<ContentRow> listVisible(String category, String keyword, LocalDate today, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + COLS + " FROM contents "
                + "WHERE review_status = 'APPROVED' "
                + "AND (effective_from IS NULL OR effective_from <= ?) "
                + "AND (effective_to IS NULL OR effective_to >= ?)");
        java.util.List<Object> args = new java.util.ArrayList<>(java.util.List.of(
                Date.valueOf(today), Date.valueOf(today)));
        if (category != null && !category.isBlank()) {
            sql.append(" AND category = ?");
            args.add(category);
        }
        if (keyword != null && !keyword.isBlank()) {
            sql.append(" AND (title LIKE ? OR summary LIKE ?)");
            args.add("%" + keyword + "%");
            args.add("%" + keyword + "%");
        }
        sql.append(" ORDER BY published_at DESC, id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), ContentRepository::map, args.toArray());
    }

    public Optional<ContentRow> findVisible(String id, LocalDate today) {
        return jdbc.query("SELECT " + COLS + " FROM contents WHERE id = ? AND review_status = 'APPROVED' "
                        + "AND (effective_from IS NULL OR effective_from <= ?) "
                        + "AND (effective_to IS NULL OR effective_to >= ?)",
                ContentRepository::map, id, Date.valueOf(today), Date.valueOf(today)).stream().findFirst();
    }
}
