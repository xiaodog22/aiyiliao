package com.wechar.biz.content;

import com.wechar.biz.common.Cursors;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.content.dto.ArticleData;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 健康科普控制器（N12/N13，2026-10-19）：
 *  GET /api/v1/health-articles（category?/type?/kw?/cursor?/limit?，匿名只读）
 *  GET /api/v1/health-articles/{articleId}（匿名只读，404=不存在或下架）
 * 两个路径均登记于 AuthInterceptor.ANONYMOUS（契约未声明 401）；未声明 429 → 不入 LIMITS。
 */
@RestController
@RequestMapping("/api/v1/health-articles")
public class HealthArticleController {

    private final HealthArticleService service;

    public HealthArticleController(HealthArticleService service) {
        this.service = service;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<ArticleData>>> list(
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String type,
            @RequestParam(required = false) String kw,
            @RequestParam(required = false) String cursor,
            @RequestParam(required = false) Integer limit) {
        var page = service.list(category, type, kw, cursor, limit);
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), page.items(),
                new Cursors.ApiMeta(page.nextCursor(), null, null)));
    }

    @GetMapping("/{articleId}")
    public ResponseEntity<Envelope<ArticleData>> detail(@PathVariable String articleId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), service.detail(articleId)));
    }
}
