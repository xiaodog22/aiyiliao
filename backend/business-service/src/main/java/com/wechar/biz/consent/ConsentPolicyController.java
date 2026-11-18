package com.wechar.biz.consent;

import com.wechar.biz.common.Envelope;
import com.wechar.biz.common.RequestIds;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * 最新隐私政策版本（审计 M11，匿名只读）：
 * GET /api/v1/consent/latest → { version, effectiveAt, title, purposes }。
 * 只下发元数据；政策全文由小程序静态页展示，防止接口内容被替换后骗取“同意”。
 */
@RestController
@RequestMapping("/api/v1/consent")
public class ConsentPolicyController {

    private final ConsentPolicy consentPolicy;

    public ConsentPolicyController(ConsentPolicy consentPolicy) {
        this.consentPolicy = consentPolicy;
    }

    @GetMapping("/latest")
    public ResponseEntity<Envelope<Map<String, Object>>> latest() {
        return ResponseEntity.ok(Envelope.ok(RequestIds.current(), consentPolicy.latest()));
    }
}
