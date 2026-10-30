package com.wechar.biz.content;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.wechar.biz.common.ApiException;
import com.wechar.biz.common.Cursors;
import com.wechar.biz.content.dto.ArticleData;
import com.wechar.biz.patient.AttachmentStorage;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 健康科普服务（N12 列表 / N13 详情，2026-10-19；契约 listHealthArticles / getHealthArticle）：
 *  - 过滤：category/type/kw + Cursors 游标分页（published_at DESC）；type 非法 → 400（契约仅声明 400）；
 *  - 封面：cover_key → AttachmentStorage.signedUrl（HMAC 短 TTL 签名 URL，红线）；缺失 → null（不渲染）；
 *  - 详情 404：不存在或未上架（不区分，不泄露草稿存在性）；
 *  - 本地 knowledge-kb.js 为前端离线降级，服务端空列表如实返回空数组（不伪造内容）。
 */
@Service
public class HealthArticleService {

    /** 契约 type 枚举。 */
    private static final Set<String> TYPES = Set.of("article", "video");
    private static final int MAX_LIMIT = 50;
    private static final int DEFAULT_LIMIT = 20;

    private static final ObjectMapper JSON = new ObjectMapper();

    private final HealthArticleRepository repository;
    private final AttachmentStorage attachmentStorage;

    public HealthArticleService(HealthArticleRepository repository, AttachmentStorage attachmentStorage) {
        this.repository = repository;
        this.attachmentStorage = attachmentStorage;
    }

    /** 列表结果：items + nextCursor（meta 由控制器装信封）。 */
    public record ArticlePage(List<ArticleData> items, String nextCursor) {
    }

    @Transactional(readOnly = true)
    public ArticlePage list(String category, String type, String kw, String cursor, Integer limitParam) {
        if (type != null && !type.isBlank() && !TYPES.contains(type.trim())) {
            throw new ApiException("BAD_REQUEST", HttpStatus.BAD_REQUEST,
                    "type 仅支持 article / video（契约枚举）");
        }
        int limit = limitParam == null ? DEFAULT_LIMIT
                : Math.min(Math.max(limitParam, 1), MAX_LIMIT);

        Instant cursorTime = null;
        String cursorId = null;
        if (cursor != null && !cursor.isBlank()) {
            Cursors.PageCursor decoded = Cursors.decode(cursor.trim());
            cursorTime = decoded.createdAt();
            cursorId = decoded.id();
        }

        List<HealthArticleRepository.ArticleRow> rows =
                repository.list(category, type == null ? null : type.trim(),
                        kw == null ? null : kw.trim(), cursorTime, cursorId, limit + 1);
        boolean hasMore = rows.size() > limit;
        List<HealthArticleRepository.ArticleRow> page = hasMore ? rows.subList(0, limit) : rows;
        List<ArticleData> items = page.stream().map(r -> toData(r, false)).toList();
        String nextCursor = hasMore && !page.isEmpty()
                ? Cursors.encode(page.get(page.size() - 1).publishedAt(), page.get(page.size() - 1).id())
                : null;
        return new ArticlePage(items, nextCursor);
    }

    @Transactional(readOnly = true)
    public ArticleData detail(String articleId) {
        return repository.findPublished(articleId)
                .map(r -> toData(r, true))
                .orElseThrow(() -> new ApiException("ARTICLE_NOT_FOUND", HttpStatus.NOT_FOUND,
                        "科普文章不存在或已下架"));
    }

    /** row → 契约 Article；detail=true 时附带 sections/tip/related 与 videoUrl。 */
    private ArticleData toData(HealthArticleRepository.ArticleRow row, boolean detail) {
        String coverUrl = row.coverKey() == null || row.coverKey().isBlank()
                ? null : attachmentStorage.signedUrl(row.coverKey());
        // 视频只在详情下发：列表没有播放器，且签名 URL 2 小时内必然过期，
        // 塞进列表只会制造无效链接、白白增大响应体。
        // 用 signedVideoUrl（TTL 7200）而不是 signedUrl（默认 900）：后者会让用户
        // 停留 15 分钟后拖动进度条时 403、播放中断。
        String videoUrl = (!detail || row.videoKey() == null || row.videoKey().isBlank())
                ? null : attachmentStorage.signedVideoUrl(row.videoKey());
        if (!detail) {
            return new ArticleData(row.id(), row.title(), row.summary(), coverUrl, row.category(),
                    row.type(), row.readMin(), row.publishedAt(), null, null, null, null, null);
        }
        return new ArticleData(row.id(), row.title(), row.summary(), coverUrl, row.category(),
                row.type(), row.readMin(), row.publishedAt(),
                parseSections(row.sectionsJson()), row.tip(), parseRelated(row.relatedJson()),
                videoUrl, null);
    }

    /** sections_json 容错解析：坏数据回空列表（详情不 500，空列表=暂无分节内容）。 */
    private static List<ArticleData.Section> parseSections(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return JSON.readValue(json, new TypeReference<List<ArticleData.Section>>() {
            });
        } catch (Exception e) {
            return List.of();
        }
    }

    private static List<String> parseRelated(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            return JSON.readValue(json, new TypeReference<List<String>>() {
            });
        } catch (Exception e) {
            return List.of();
        }
    }
}
