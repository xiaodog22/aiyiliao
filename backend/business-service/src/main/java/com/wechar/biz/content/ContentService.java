package com.wechar.biz.content;

import com.wechar.biz.common.ApiException;
import com.wechar.biz.content.dto.ContentDetailData;
import com.wechar.biz.content.dto.ContentItemData;
import java.time.Clock;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * 健康科普内容只读服务（M1 content 域）。
 * 只返回 APPROVED 且在有效期内的条目（草稿/过期/撤回不出现在列表，契约 /contents 描述）。
 */
@Service
public class ContentService {

    private static final int MAX_LIMIT = 50;

    /** 展示时区（内容有效期按北京时间日历日判断，问候语另按 Asia/Shanghai）。 */
    private static final ZoneId ZONE = ZoneId.of("Asia/Shanghai");

    private final ContentRepository repository;
    private final Clock clock;

    public ContentService(ContentRepository repository, Clock clock) {
        this.repository = repository;
        this.clock = clock;
    }

    @Transactional(readOnly = true)
    public List<ContentItemData> list(String category, String keyword, int limit) {
        int bounded = Math.min(Math.max(limit, 1), MAX_LIMIT);
        LocalDate today = LocalDate.now(clock.withZone(ZONE));
        return repository.listVisible(category, keyword, today, bounded).stream()
                .map(this::toItem).toList();
    }

    @Transactional(readOnly = true)
    public ContentDetailData detail(String contentId) {
        LocalDate today = LocalDate.now(clock.withZone(ZONE));
        var row = repository.findVisible(contentId, today)
                .orElseThrow(() -> new ApiException("CONTENT_NOT_FOUND", HttpStatus.NOT_FOUND, "内容不存在或未通过审核"));
        var item = toItem(row);
        return new ContentDetailData(item.id(), item.title(), item.summary(), item.category(), item.coverKey(),
                item.coverUrl(), item.contentType(), item.videoUrl(), item.durationSec(), item.readTimeSec(),
                item.reviewStatus(), item.effectiveFrom(), item.effectiveTo(),
                item.publishedAt(), item.readCount(), row.body(), row.source(), row.reviewer());
    }

    private ContentItemData toItem(ContentRepository.ContentRow row) {
        return new ContentItemData(row.id(), row.title(), row.summary(), row.category(), row.coverKey(),
                row.coverUrl(), row.contentType(), row.videoUrl(), row.durationSec(), row.readTimeSec(),
                row.reviewStatus(), row.effectiveFrom(), row.effectiveTo(), row.publishedAt(),
                row.readCount());
    }
}
