package com.wechar.biz.exam;

import com.wechar.biz.auth.AuthService;
import com.wechar.biz.common.CurrentUserContext;
import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.IdempotencyKeys;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.exam.dto.ExamConfigData;
import com.wechar.biz.exam.dto.ExamCreateRequest;
import com.wechar.biz.exam.dto.ExamItemData;
import com.wechar.biz.exam.dto.ExamOrderData;
import com.wechar.biz.exam.dto.ExamSlotsData;
import jakarta.validation.Valid;
import java.util.List;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 检查预约控制器（P0-2）。
 *
 * <p>路径见 backend/contracts/business-openapi.yaml：
 * config / items / slots / orders / orders/me / orders/{requestNo} / orders/{requestNo}/cancel。
 * 写操作必须带 Idempotency-Key；金额由服务端取 HIS 项目价。
 */
@RestController
@RequestMapping("/api/v1/exam")
public class ExamController {

    private final ExamService examService;
    private final AuthService authService;
    private final CurrentUserContext currentUserContext;

    public ExamController(ExamService examService, AuthService authService,
                          CurrentUserContext currentUserContext) {
        this.examService = examService;
        this.authService = authService;
        this.currentUserContext = currentUserContext;
    }

    @GetMapping("/config")
    public Envelope<ExamConfigData> config() {
        return Envelope.ok(RequestIds.current(), examService.config());
    }

    @GetMapping("/items")
    public Envelope<List<ExamItemData>> items() {
        return Envelope.ok(RequestIds.current(), examService.items());
    }

    @GetMapping("/items/{itemCode}/slots")
    public Envelope<ExamSlotsData> slots(@PathVariable String itemCode) {
        return Envelope.ok(RequestIds.current(), examService.slots(itemCode));
    }

    @PostMapping("/orders")
    public ResponseEntity<Envelope<ExamOrderData>> create(
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey,
            @Valid @RequestBody ExamCreateRequest request) {
        String key = IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(),
                examService.create(userId, request, key)));
    }

    @GetMapping("/orders/me")
    public Envelope<List<ExamOrderData>> mine() {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(), examService.listMine(userId));
    }

    @GetMapping("/orders/{requestNo}")
    public Envelope<ExamOrderData> get(@PathVariable String requestNo) {
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(), examService.get(userId, requestNo));
    }

    @PostMapping("/orders/{requestNo}/cancel")
    public Envelope<ExamOrderData> cancel(
            @PathVariable String requestNo,
            @RequestHeader(value = IdempotencyKeys.HEADER, required = false) String idempotencyKey) {
        IdempotencyKeys.require(idempotencyKey);
        String userId = authService.ensureUser(currentUserContext.currentUserId());
        return Envelope.ok(RequestIds.current(), examService.cancel(userId, requestNo));
    }
}
