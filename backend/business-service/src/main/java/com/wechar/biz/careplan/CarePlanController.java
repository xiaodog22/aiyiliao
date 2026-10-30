package com.wechar.biz.careplan;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.careplan.dto.CarePlanData;
import com.wechar.biz.careplan.dto.CarePlanRequest;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 照护建议控制器（M2.4，契约 POST /api/v1/care-plans）：
 * 同步返回（Idempotency-Key 必填）；输出定位为生活方式建议，不构成处方。
 * goal/constraints 属敏感健康信息，不进入埋点与日志正文。
 */
@RestController
@RequestMapping("/api/v1/care-plans")
public class CarePlanController {

    private final CarePlanService carePlanService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public CarePlanController(CarePlanService carePlanService, AuthService authService,
                              CurrentUserContext currentUserContext) {
        this.carePlanService = carePlanService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    /** 生成养生/照护建议（证据不足 → 结构化拒答，不用通用养生话术填充）。 */
    @PostMapping
    public ResponseEntity<Envelope<CarePlanData>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody CarePlanRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        var generated = carePlanService.create(userId, key, request);
        return ResponseEntity.ok()
                .header(IdempotencyKeys.REPLAY_HEADER, String.valueOf(generated.replayed()))
                .body(Envelope.ok(RequestIds.current(), generated.plan()));
    }
}
