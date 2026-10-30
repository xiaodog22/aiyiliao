package com.wechar.biz.home;

import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.home.dto.HomeBriefData;
import com.wechar.biz.home.dto.HomeSummaryData;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * home 控制器（M1.5）：
 *  GET /api/v1/home（任务书路径 → HomeBrief）
 *  GET /api/v1/home/summary（契约路径 → HomeSummary）
 */
@RestController
@RequestMapping("/api/v1/home")
public class HomeController {

    private final HomeService homeService;
    private final CurrentUserContext currentUserContext;

    public HomeController(HomeService homeService, CurrentUserContext currentUserContext) {
        this.homeService = homeService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping
    public ResponseEntity<Envelope<HomeBriefData>> brief() {
        String userId = currentUserContext.currentUserId();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), homeService.brief(userId)));
    }

    @GetMapping("/summary")
    public ResponseEntity<Envelope<HomeSummaryData>> summary() {
        String userId = currentUserContext.currentUserId();
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), homeService.summary(userId)));
    }
}
