package com.wechar.biz.dev;

import com.wechar.biz.bed.BedApplicationService;
import com.wechar.biz.bed.dto.BedApplicationData;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import java.util.List;
import org.springframework.context.annotation.Profile;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 床位申请的「护士站」审批端点（dev 档专用，2026-11-15）。
 *
 * 为什么放在 dev：系统只有患者/医生两种登录身份，没有护士站账号；
 * 申请制要求医生只能提交、不能自审，因此审批在演示环境由本端点代护士站执行。
 * 生产环境 Bean 不装配，路径直接 404 —— 正式上线需接入住院处系统或管理后台。
 *
 *   GET  /api/v1/dev/bed-applications?status=PENDING   待审批申请（默认 PENDING）
 *   POST /api/v1/dev/bed-applications/{id}/review      审批：{decision: APPROVED|REJECTED, note?}
 */
@RestController
@RequestMapping("/api/v1/dev/bed-applications")
@Profile("dev")
public class DevBedApplicationController {

    /** 演示环境审批人标识（申请单里留存，便于追溯是谁批的）。 */
    private static final String DEMO_REVIEWER = "nurse-station(dev)";

    private final BedApplicationService applicationService;

    public DevBedApplicationController(BedApplicationService applicationService) {
        this.applicationService = applicationService;
    }

    @GetMapping
    public Envelope<List<BedApplicationData>> list(
            @RequestParam(required = false, defaultValue = "PENDING") String status) {
        return Envelope.ok(RequestIds.current(), applicationService.listForReview(status));
    }

    @PostMapping("/{id}/review")
    public Envelope<BedApplicationData> review(@PathVariable String id,
                                               @RequestBody(required = false) ReviewRequest request) {
        ReviewRequest body = request == null ? new ReviewRequest(null, null) : request;
        return Envelope.ok(RequestIds.current(),
                applicationService.review(id, body.decision(), body.note(), DEMO_REVIEWER));
    }

    /** 审批载荷：decision 必填（APPROVED / REJECTED），note 选填。 */
    public record ReviewRequest(String decision, String note) {
    }
}
