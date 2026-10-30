package com.wechar.biz.resource;

import java.util.List;
import java.util.Optional;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.stereotype.Component;

/**
 * resource_asset 只读数据访问（V14）。
 *
 * 表只存元数据与相对路径，二进制在文件系统：本类不接触任何图片字节，
 * 避免把大对象读进堆（契约红线：禁止 byte[] 整文件入堆）。
 */
@Component
public class ResourceAssetRepository {

    private final JdbcTemplate jdbc;

    public ResourceAssetRepository(JdbcTemplate jdbc) {
        this.jdbc = jdbc;
    }

    /** 一行资源元数据；filePath 为相对 app.resources.dir 的路径。 */
    public record AssetRow(String resourceKey, String category, String filePath, String mimeType,
                           Long fileSize, String sha256, String level, String bundlePath, int sortOrder) {
    }

    private static final String COLS =
            "resource_key, category, file_path, mime_type, file_size, sha256, level, bundle_path, sort_order";

    private static final RowMapper<AssetRow> ROW = (rs, i) -> {
        // ⚠️ wasNull() 只反映「最后一次 getter」：必须在任何其它 getter 之前取判定值，
        //    否则会被后续 getString 覆盖，NULL 的 file_size 会静默变成 0。
        long size = rs.getLong("file_size");
        Long fileSize = rs.wasNull() ? null : size;
        return new AssetRow(
                rs.getString("resource_key"),
                rs.getString("category"),
                rs.getString("file_path"),
                rs.getString("mime_type"),
                fileSize,
                rs.getString("sha256"),
                rs.getString("level"),
                rs.getString("bundle_path"),
                rs.getInt("sort_order"));
    };

    /** 按 key 取**启用**记录：status=0 与不存在同样按 404 处理（不泄露停用资源的存在性）。 */
    public Optional<AssetRow> findActiveByKey(String key) {
        return jdbc.query("SELECT " + COLS + " FROM resource_asset WHERE resource_key = ? AND status = 1",
                        ROW, key)
                .stream().findFirst();
    }

    /**
     * 清单候选：只取「启用 + 图片 mime + delivery=remote」的登记项。
     *
     * 为什么必须卡 delivery：219 个 96×96 图标本来就在包里（0ms 可取），
     * 全量下发 url 会让每次渲染都发一次网络请求，是净亏。`local` 条目在 DB 可查、
     * `GET /api/v1/resources/{key}` 也可取，只是**清单不下发 url**，前端用 bundlePath。
     *
     * 视频/PDF 同样不进清单（契约 items.mime 仅图片）。
     */
    public List<AssetRow> listActiveImageItems() {
        return jdbc.query("SELECT " + COLS + " FROM resource_asset WHERE status = 1 "
                + "AND delivery = 'remote' "
                + "AND mime_type IN ('image/png', 'image/jpeg', 'image/webp') "
                + "ORDER BY sort_order ASC, id ASC", ROW);
    }
}
