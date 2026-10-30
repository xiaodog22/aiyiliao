package com.wechar.biz.content;

import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 健康科普内容数据访问（N12/N13，V13 health_articles 表）。
 * 只读目录：status=PUBLISHED 才可见（草稿/下架对客户端 404/不出现）。
 * 游标分页按 (published_at DESC, id DESC)——与 Cursors.PageCursor 同一游标口径。
 */
@Component
public class HealthArticleRepository {

    private final JdbcTemplate jdbc;

    public HealthArticleRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /**
     * 行投影。videoKey（V19）与 coverKey 同构：都是 AttachmentStorage 的对象键，
     * 由 Service 拼成签名 URL 后才下发；未配置视频时恒 null。
     */
    public record ArticleRow(String id, String title, String summary, String coverKey, String category,
                             String type, Integer readMin, Instant publishedAt, String sectionsJson,
                             String tip, String relatedJson, String videoKey) {
    }

    private static final String COLS =
            "id, title, summary, cover_key, category, type, read_min, published_at, sections_json, tip, related_json, video_key";

    private static ArticleRow map(java.sql.ResultSet rs, int i) throws java.sql.SQLException {
        Timestamp published = rs.getTimestamp("published_at");
        return new ArticleRow(rs.getString("id"), rs.getString("title"), rs.getString("summary"),
                rs.getString("cover_key"), rs.getString("category"), rs.getString("type"),
                (Integer) rs.getObject("read_min"), published == null ? null : published.toInstant(),
                rs.getString("sections_json"), rs.getString("tip"), rs.getString("related_json"),
                rs.getString("video_key"));
    }

    /**
     * 列表（N12）：category/type/kw 过滤 + 游标（cursorTime/cursorId 之后的更旧条目）。
     * kw 匹配标题/摘要（LIKE，% 由调用方拼入前已转义输入中的 %/_ 见 service）。
     */
    public List<ArticleRow> list(String category, String type, String kw,
                                 Instant cursorTime, String cursorId, int limit) {
        StringBuilder sql = new StringBuilder("SELECT " + COLS
                + " FROM health_articles WHERE status = 'PUBLISHED'");
        java.util.List<Object> args = new java.util.ArrayList<>();
        if (category != null && !category.isBlank()) {
            sql.append(" AND category = ?");
            args.add(category);
        }
        if (type != null && !type.isBlank()) {
            sql.append(" AND type = ?");
            args.add(type);
        }
        if (kw != null && !kw.isBlank()) {
            sql.append(" AND (title LIKE ? OR summary LIKE ?)");
            args.add("%" + kw + "%");
            args.add("%" + kw + "%");
        }
        if (cursorTime != null) {
            sql.append(" AND (published_at < ? OR (published_at = ? AND id < ?))");
            args.add(Timestamp.from(cursorTime));
            args.add(Timestamp.from(cursorTime));
            args.add(cursorId);
        }
        sql.append(" ORDER BY published_at DESC, id DESC LIMIT ?");
        args.add(limit);
        return jdbc.query(sql.toString(), HealthArticleRepository::map, args.toArray());
    }

    /** 详情（N13）：不存在/未上架 → empty（调用方 404）。 */
    public Optional<ArticleRow> findPublished(String id) {
        if (id == null || id.isBlank()) {
            return Optional.empty();
        }
        return jdbc.query("SELECT " + COLS + " FROM health_articles WHERE id = ? AND status = 'PUBLISHED'",
                HealthArticleRepository::map, id).stream().findFirst();
    }
}
