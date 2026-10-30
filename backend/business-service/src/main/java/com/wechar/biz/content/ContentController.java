package com.wechar.biz.content;

import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.content.dto.ContentDetailData;
import com.wechar.biz.content.dto.ContentItemData;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/** content 控制器：GET /api/v1/contents · GET /api/v1/contents/{contentId}（只读）。 */
@RestController
@RequestMapping("/api/v1/contents")
public class ContentController {

    private final ContentService contentService;

    public ContentController(ContentService contentService) {
        this.contentService = contentService;
    }

    @GetMapping
    public ResponseEntity<Envelope<List<ContentItemData>>> list(
            @RequestParam(required = false) String category,
            @RequestParam(required = false) String keyword,
            @RequestParam(required = false, defaultValue = "20") int limit) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                contentService.list(category, keyword, limit)));
    }

    @GetMapping("/{contentId}")
    public ResponseEntity<Envelope<ContentDetailData>> detail(@PathVariable String contentId) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), contentService.detail(contentId)));
    }
}
