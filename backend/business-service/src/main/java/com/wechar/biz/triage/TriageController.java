package com.wechar.biz.triage;

import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import com.wechar.biz.triage.dto.EmergencyCheckData;
import com.wechar.biz.triage.dto.EmergencyCheckRequest;
import com.wechar.biz.triage.dto.TriageRequest;
import com.wechar.biz.triage.dto.TriageResultData;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * triage 控制器（M1.6）：
 *  POST /api/v1/triage（任务书路径）→ 规则导诊结果
 *  POST /api/v1/triage/recommendations（契约路径）→ 同一服务
 *  POST /api/v1/triage/emergency-check（任务书）与 POST /api/v1/triage/emergency-checks（契约）→ 同一服务。
 */
@RestController
@RequestMapping("/api/v1/triage")
public class TriageController {

    private final TriageService triageService;

    public TriageController(TriageService triageService) {
        this.triageService = triageService;
    }

    @PostMapping
    public ResponseEntity<Envelope<TriageResultData>> triage(@Valid @RequestBody TriageRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), triageService.recommend(request)));
    }

    @PostMapping("/recommendations")
    public ResponseEntity<Envelope<TriageResultData>> recommendations(@Valid @RequestBody TriageRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), triageService.recommend(request)));
    }

    @PostMapping("/emergency-check")
    public ResponseEntity<Envelope<EmergencyCheckData>> emergencyCheck(
            @Valid @RequestBody EmergencyCheckRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), triageService.check(request)));
    }

    @PostMapping("/emergency-checks")
    public ResponseEntity<Envelope<EmergencyCheckData>> emergencyChecks(
            @Valid @RequestBody EmergencyCheckRequest request) {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), triageService.check(request)));
    }
}
